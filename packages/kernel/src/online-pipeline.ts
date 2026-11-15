/**
 * Online RSI pipeline (DD-FND-070/071/072, DD-QP-26, DD-EVD-002, DD-TRG-003/006).
 *
 * One committed HOST event is carried through the documented flow:
 *
 *   committed event
 *     -> HOST policy, capability gate and trigger decision
 *     -> HOST admission (TriggerEvent + ReviewEnqueueRequest + pending) and progress
 *     -> QP issue discovery and plan
 *     -> EVD pack, closure, shard plan and JudgeRequestBinding/3
 *     -> Jev gateway dispatch and categorical validation
 *     -> AnswerAggregate
 *     -> issue judgment / evidence or abstain transition
 *     -> decision record
 *     -> delivery create and outbox enqueue
 *
 * Ownership boundaries are preserved. The kernel orders the stages and never
 * re-implements a detector, a compiler, a validator or a reducer. Cross-domain
 * read/write seams that the kernel cannot own are injected:
 *
 *   - `host` (adapter trigger facts / generation facts),
 *   - `capability` (HOST capability records),
 *   - `proof` (HOST human proof),
 *   - `qp` (QuestionPlanner constructed by the QP owner),
 *   - `jev` (semantic backend + late-result store).
 *
 * Fail-closed: a missing backend, capability port, planner, compiler writer or
 * answer aggregator yields a typed `ErrorEnvelope` at the stage that needs it.
 * This module never invents a trigger decision, a Jev answer, an aggregate, a
 * judgment, a decision record or a delivery.
 */

import type {
  CapabilityName,
  CapabilityStatus,
  Clock,
  DecisionDraft,
  ErrorDetails,
  ErrorEnvelope,
  EventDraft,
  EvidenceStage,
  Hash,
  HostEventBinding,
  HostId,
  Id,
  IngestReceipt,
  Result,
  SourceRef,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalHash,
  err,
  isId,
  makeErrorEnvelope,
  newId,
  ok,
  parseSourceRef,
  systemClock
} from "@evoplug/core";
import type {
  CapabilityGateResult,
  DispatchEvidenceView,
  DispatchHardFactView,
  DispatchPlanView,
  HostGenerationPort,
  HumanAttestation,
  OriginProofPort,
  PendingChange,
  PlanDispatchDecision,
  ReviewEnqueueRequest,
  ReviewSchedulerPort,
  StateRowLiveCommitPort,
  StableBoundaryEvidence,
  TriggerDecision,
  TriggerDedupe,
  TriggerEvent,
  TriggerOrigin,
  TriggerPolicy,
  TriggerScope,
  VerifiedSignal
} from "@evoplug/core/host";
import {
  admitTrigger,
  buildCapabilityGate,
  capabilityGatePassed,
  decideAutomatic,
  decideExplicit,
  decidePlanDispatch
} from "@evoplug/core/host";
import type {
  AggregatePlanView,
  AnswerAggregateV2,
  AnswerAggregator,
  EvdStateWritePort as EvidenceEvdStateWritePort,
  EvidenceBindingReadPort,
  EvidenceIndexSnapshot,
  EvidenceIssueReadPort,
  EvidencePack,
  EvidencePlanReadPort,
  GatewayAttemptPersistence,
  GatewayLateStore,
  JevServiceProfile,
  JudgeEnvelopeV3,
  JudgeGateway,
  JudgeRequestBindingV3,
  Omission,
  PlanReadPort,
  RunBudget,
  SemanticBackendCapability,
  SemanticBackendPort,
  SemanticBackendRef,
  Shard,
  ShardPlan
} from "@evoplug/evidence";
import {
  buildTemplateBindings,
  createEvidenceCompiler,
  createJudgeGateway,
  omissionKey
} from "@evoplug/evidence";
import { qpFailure } from "@evoplug/core/evidence";
import type {
  EvidenceSupplementHookPort,
  EvidenceSupplementInput,
  SupplementBudgetInput,
  SupplementFact,
  SupplementGapView,
  SupplementPackView,
  SupplementRebuildPort
} from "./evidence-supplement.js";
import type {
  DeliveryContentCheck,
  DeliveryCreateResult,
  DeliveryOutboxEnqueue,
  DeliveryPlan
} from "@evoplug/delivery";
import type { DispatchMode } from "./features.js";
import type { DispatchAuditAppend, DispatchAuditJournal } from "./dispatch-audit.js";
import { resolveDispatchAuditPort } from "./dispatch-audit.js";

/** Re-exported so the previous import path keeps working; one declaration only. */
export type { DispatchMode } from "./features.js";

/* ------------------------------------------------------------------ */
/* Public vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type OnlinePipelineStage =
  | "event_commit"
  | "trigger_policy"
  | "trigger_admission"
  | "progress_checkpoint"
  | "issue_discovery"
  | "issue_plan"
  | "evidence_pack"
  | "evidence_shard"
  | "evidence_binding"
  | "jev_dispatch"
  | "aggregation"
  | "issue_judgment"
  | "issue_close"
  | "decision_record"
  | "delivery";

/** The committed event handed to the pipeline after the `event.ingest` ACK. */
export interface CommittedHostEvent {
  readonly receipt: IngestReceipt;
  readonly draft: EventDraft;
  readonly binding: VersionBinding;
}

/** HOST adapter facts. The adapter reports; the kernel never derives them. */
export interface HostAdapterFacts {
  readonly host_id: HostId;
  readonly host_version: string;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly implementation_hash: Hash;
  readonly stream_id: Hash;
  readonly event_identity_key: Hash;
  readonly source_seq?: number;
  readonly native_occurrence_id?: string;
  readonly retry_of?: string;
  readonly occurred_at?: number;
}

/** Facts a HOST adapter must observe before a trigger can be decided. */
export interface HostTriggerFacts {
  readonly adapter: HostAdapterFacts;
  readonly trigger_kind: TriggerEvent["trigger_kind"];
  readonly origin: TriggerOrigin;
  readonly request_intent: "automatic" | "explicit_review";
  /** Explicit staged snapshot request. */
  readonly stage: boolean;
  readonly signals: readonly VerifiedSignal[];
  readonly boundary: StableBoundaryEvidence;
  readonly scope: TriggerScope;
  readonly identity_quality: "strong" | "weak" | "missing";
  readonly source_event_ref: SourceRef;
  readonly raw_event_ref: SourceRef;
  readonly stable_evidence_ref?: SourceRef;
  readonly staged_missing_refs?: readonly [SourceRef, ...SourceRef[]];
  readonly review_scope_key: Hash;
  readonly dedupe: TriggerDedupe;
  readonly authorization_ref: Id<"grant"> | null;
  readonly human_attestation?: HumanAttestation;
  readonly policy_snapshot_ref: SourceRef;
  readonly evidence_refs: readonly string[];
  readonly job_live: boolean;
  readonly replay_duplicate: boolean;
  readonly auto_quota_exhausted: boolean;
}

/** HOST adapter/generation surface used by the pipeline. */
export interface HostPipelinePort {
  /** Adapter-observed trigger facts. */
  facts(event: CommittedHostEvent): Promise<Result<HostTriggerFacts, ErrorEnvelope>>;
  /** Active trigger policy for the event scope, if one exists. */
  policy(event: CommittedHostEvent): Promise<Result<TriggerPolicy | null, ErrorEnvelope>>;
  /** Pending after-images caused by the decision (defer, delivery, resume). */
  pending(
    event: CommittedHostEvent,
    facts: HostTriggerFacts,
    decision: TriggerDecision
  ): Promise<Result<readonly PendingChange[], ErrorEnvelope>>;
  /** HOST generation port; only used when a generation resume is needed. */
  readonly generation?: HostGenerationPort;
}

/** HOST capability lookup and snapshot hash. */
export interface CapabilityPipelinePort {
  lookup(name: CapabilityName): {
    readonly status: CapabilityStatus;
    readonly evidence_stage: EvidenceStage;
  } | null;
  snapshotHash(): Result<Hash, ErrorEnvelope>;
}

/** Budget availability gate used by the automatic decision. */
export interface BudgetAvailabilityPort {
  available(): Promise<Result<boolean, ErrorEnvelope>>;
}

/** Progress checkpoint write seam (HOST owns the checkpoint shape). */
export interface ProgressPipelinePort {
  ensure(input: {
    readonly event: CommittedHostEvent;
    readonly trigger: TriggerEvent;
    readonly decision: TriggerDecision;
  }): Promise<Result<unknown, ErrorEnvelope>>;
}

/** Pending write seam for decisions that do not pass through admission. */
export interface PendingPipelinePort {
  commit(input: {
    readonly binding: VersionBinding;
    readonly changes: readonly PendingChange[];
  }): Promise<Result<unknown, ErrorEnvelope>>;
}

/* ------------------------------ QP -------------------------------- */

/**
 * Structural QP issue projection. The QP owner publishes the concrete `Issue`;
 * the kernel only reads these fields.
 */
export interface OnlineIssue {
  readonly issue_id: string;
  readonly issue_key: string;
  readonly issue_type: string;
  readonly issue_version: number;
  readonly state: string;
  readonly requirement_ids: string[];
  readonly question_text: string | null;
}

/** Structural QP plan projection. */
export interface OnlineQuestionPlan {
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly issue_id: string;
  readonly issue_key: string;
  readonly binding: VersionBinding;
  readonly questions: ReadonlyArray<{
    readonly question_key: string;
    readonly template_id: string;
    readonly template_version: string;
    readonly template_hash: string;
    readonly required_for_issue: boolean;
  }>;
}

/** QP-owned lifecycle state carried beside (never inside) the plan. */
export type OnlinePlanState =
  | "active"
  | "superseded"
  | "stale_goal"
  | "stale_binding"
  | "stale_template"
  | "rejected";

export interface OnlineQuestionTemplateRegistry {
  readonly schema_version: string;
  readonly registry_version: string;
  readonly registry_hash: string;
  readonly templates: ReadonlyArray<{
    readonly template_id: string;
    readonly template_version: string;
    readonly template_hash: string;
    readonly status: "active" | "deprecated";
  }>;
}

export interface QpDiscoveryInput {
  readonly binding: VersionBinding;
  readonly watermark: number;
  readonly progress_from_watermark: number;
  readonly policy_version: string;
}

export interface QpDiscoveryResult {
  readonly status: "ok" | "no_op" | "truncated" | "rejected";
  readonly issues: readonly OnlineIssue[];
  readonly errors: ReadonlyArray<{ readonly code: string }>;
}

export type QpPlanningResult =
  | {
      readonly status: "planned";
      readonly plan: OnlineQuestionPlan;
      /** QP's persisted lifecycle state, returned beside the plan. */
      readonly plan_state?: OnlinePlanState;
    }
  | {
      readonly status: "no_op";
      readonly reason: string;
      readonly issue_id?: string;
    }
  | { readonly status: "deferred"; readonly reason: string; readonly issue_id: string }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly issue_id: string;
    };

export interface QpTransitionResult {
  readonly status: "ok" | "no_op" | "rejected";
  readonly issue?: OnlineIssue;
  readonly errors: ReadonlyArray<{ readonly code: string }>;
}

export interface OnlineCloseEvidenceDraft {
  readonly kind: "verified_behavior" | "verified_artifact" | "human_acceptance" | "coverage_completion";
  readonly evidence_id: string;
  readonly source_refs: SourceRef[];
  readonly goal_version: string;
  readonly requirement_ids: string[];
  readonly artifact_version: string | null;
  readonly verifier_ref: string | null;
}

/**
 * The QP owner's `QuestionPlanner`. The concrete planner is supplied by the
 * composition root because `@evoplug/core` does not publish the QP submodule
 * from its package root yet.
 */
export interface QpPlannerPort {
  readonly deps: { readonly evidence: EvidenceIndexSnapshot };
  discover(input: QpDiscoveryInput): QpDiscoveryResult;
  plan(input: {
    readonly binding: VersionBinding;
    readonly issue: OnlineIssue;
    readonly registry: OnlineQuestionTemplateRegistry;
    readonly policy_version: string;
  }): QpPlanningResult;
  recordJudgment(command: {
    readonly transition_id: string;
    readonly issue_id: string;
    readonly expected_version: number;
    readonly source: {
      readonly kind: "answer_aggregate";
      readonly aggregate_id: string;
      readonly expected_aggregate_hash: string;
      readonly plan_id: string;
      readonly plan_hash: string;
    };
  }): Promise<QpTransitionResult>;
  requireEvidence(command: {
    readonly transition_id: string;
    readonly issue_id: string;
    readonly expected_version: number;
    readonly gaps: ReadonlyArray<{
      readonly code: string;
      readonly requirement_ids: string[];
      readonly source_refs: SourceRef[];
      readonly affects_question_keys: string[];
    }>;
    readonly reason: "evidence_missing" | "feedback_correction" | "counterevidence";
  }): QpTransitionResult;
  abstain(command: {
    readonly transition_id: string;
    readonly issue_id: string;
    readonly expected_version: number;
    readonly reason: "budget_exhausted" | "unresolved_conflict";
    readonly gaps: ReadonlyArray<{
      readonly code: string;
      readonly requirement_ids: string[];
      readonly source_refs: SourceRef[];
      readonly affects_question_keys: string[];
    }>;
  }): QpTransitionResult;
  close(command: {
    readonly transition_id: string;
    readonly issue_id: string;
    readonly expected_version: number;
    readonly mode: "judgment";
    readonly close_evidence: OnlineCloseEvidenceDraft;
  }): Promise<QpTransitionResult>;
}

export interface QpPipelineDeps {
  readonly planner: QpPlannerPort;
  readonly registry: OnlineQuestionTemplateRegistry;
  /** `qp.issue_detector/1` by default. */
  readonly detector_version?: string;
  /** `qp.planner/1` by default. */
  readonly planner_version?: string;
  /** Window start for discovery; defaults to the binding watermark. */
  readonly progress_from_watermark?: number;
}

/* ------------------------------ EVD ------------------------------- */

export interface EvdPipelineDeps {
  readonly plans: EvidencePlanReadPort;
  /**
   * QP-owned lifecycle read port. Plans produced by the planner carry their
   * state in `plan_states`; a plan loaded from a repository must resolve its
   * lifecycle through this port. Absence is only safe when every compiled
   * plan is present in the planner's map.
   */
  readonly plan_lifecycle?: PlanReadPort;
  readonly issues: EvidenceIssueReadPort;
  readonly binding?: EvidenceBindingReadPort;
  readonly writer: EvdStateWritePort;
  readonly backend: SemanticBackendRef;
  readonly service_profile: JevServiceProfile | SemanticBackendCapability;
  readonly service_profile_key: Hash;
  readonly validator_binding_id: Id;
  readonly validator_binding_key: Hash;
  readonly limits: RunBudget;
  readonly compiler_version?: string;
  readonly counting_method_version?: string;
  /** Absolute monotonic deadline for `buildRequest`. */
  readonly deadline_at_monotonic_ms?: number;
}

/** EVD typed-row writer, owned by `@evoplug/evidence`. */
export type EvdStateWritePort = EvidenceEvdStateWritePort;

/* ------------------------------ Jev ------------------------------- */

export interface JevPipelineDeps {
  /** Real semantic backend. Absence fails closed at `jev_dispatch`. */
  readonly backend?: SemanticBackendPort;
  /** Durable late-result store required by the gateway. */
  readonly late?: GatewayLateStore;
  /** Optional pre-built gateway; otherwise built from `backend` + `late`. */
  readonly gateway?: JudgeGateway;
  /** Budget cap for one dispatch. Absence fails closed before dispatch. */
  readonly budget?: RunBudget;
  /** Attempt numbering for persisted attempts; defaults to a single attempt. */
  readonly next_attempt_no?: (binding_id: string) => number;
}

/* --------------------------- judgment ----------------------------- */

/* --------------------- deterministic dispatch --------------------- */

/**
 * Deterministic dispatch policy (W3).
 *
 * `off` is the default and preserves the classic full dispatch. `shadow`
 * computes the decision and records it without changing dispatching.
 * `enforce` skips every shard whose questions are all settled by verified
 * hard facts or by an evidence gap.
 */
export interface DispatchAuditInput {
  readonly mode: DispatchMode;
  /** Complete binding the skip was decided under. */
  readonly binding: VersionBinding;
  readonly plan_id: string;
  readonly decision: PlanDispatchDecision;
  readonly skipped_shard_keys: readonly string[];
  readonly dispatched_shard_keys: readonly string[];
}

/**
 * Durable audit sink for dispatch decisions.
 *
 * `enforce` skips shards, so every skip must be persisted before the skip
 * happens. The port is therefore awaited and its failure fails the EVD stage;
 * a missing port in `enforce` mode fails closed with
 * `E_DISPATCH_AUDIT_UNAVAILABLE` rather than silently dropping the record.
 * `shadow` may use the same port, but a failure there never changes control
 * flow.
 *
 * The shard rows and omission rows carry the durable skip itself. This record
 * adds the plan-level decision the rows cannot: complete `VersionBinding`,
 * every decided/gap/semantic question, fact keys and the skipped/dispatched
 * shard lists.
 */
export interface DispatchAuditPort {
  record(
    input: DispatchAuditInput
  ): Promise<Result<{ readonly audit_id: string }, ErrorEnvelope>>;
}

export interface DispatchPipelineOptions {
  readonly mode: DispatchMode;
  readonly audit?: DispatchAuditPort;
  /**
   * Foundation journal writer. This is the producer bootstrap already has:
   * the same shared `JournalWriter` handed to the EVD composition. When set,
   * the audit is appended as one `evd.dispatch_audit.recorded` frame before
   * any shard is committed or dispatched.
   */
  readonly journal?: DispatchAuditJournal;
  /**
   * Durable append seam (journal/outbox) used to build the audit port when
   * neither `audit` nor `journal` is supplied. Supplying it is enough for
   * `enforce`; it is not a weaker gate than an injected port.
   */
  readonly journal_append?: DispatchAuditAppend;
}

/* --------------------- evidence supplementation ------------------- */

/**
 * W4 owns the supplementary request/outcome/port types; the online pipeline
 * only calls the hook and records its outcome. Absence preserves the classic
 * `needs_evidence` handling. The hook is called once per aggregate that needs
 * evidence; this round's judgment is never rewritten, so newly found facts
 * take effect on the next committed event.
 */
export interface SupplementPipelineOptions {
  readonly port: EvidenceSupplementHookPort;
  readonly enabled?: boolean;
  readonly budget?: SupplementBudgetInput;
  /**
   * Frozen-snapshot rebuild (W4). A `resolved` outcome whose facts live
   * outside the original freeze, or which explicitly asks for a repack, is
   * applied only through this port: it reloads the same binding, compiles a
   * new pack/shard plan and re-aggregates. Without it the aggregate stays
   * `needs_evidence` and the repack requirement is recorded as a diagnostic.
   */
  readonly rebuild?: SupplementRebuildPort;
}

/** Independent close evidence. A Jev answer alone never closes an issue. */
export interface CloseEvidencePipelinePort {
  read(input: {
    readonly event: CommittedHostEvent;
    readonly issue: OnlineIssue;
    readonly aggregate: AnswerAggregateV2;
    readonly pack: EvidencePack;
  }): Promise<Result<OnlineCloseEvidenceDraft | null, ErrorEnvelope>>;
}

/* --------------------------- decision ----------------------------- */

export interface DecisionRecordPort {
  record(draft: DecisionDraft): Promise<
    Result<{ readonly decision_id: Id<"dec">; readonly created: boolean }, ErrorEnvelope>
  >;
}

/** FND snapshot hashes required by `DecisionDraft.inputs`. */
export interface DecisionInputsPipelinePort {
  read(input: {
    readonly event: CommittedHostEvent;
    readonly binding: VersionBinding;
    readonly issue: OnlineIssue;
    readonly aggregate: AnswerAggregateV2;
  }): Promise<Result<DecisionDraft["inputs"], ErrorEnvelope>>;
}

/* --------------------------- delivery ----------------------------- */

export interface DeliveryPreparation {
  readonly plan: DeliveryPlan;
  readonly content: DeliveryContentCheck;
  readonly outbox: DeliveryOutboxEnqueue<"delivery.dispatch">;
}

export interface DeliveryPipelinePort {
  prepare(input: {
    readonly event: CommittedHostEvent;
    readonly issue: OnlineIssue;
    readonly aggregate: AnswerAggregateV2;
    readonly pack: EvidencePack;
  }): Promise<Result<DeliveryPreparation, ErrorEnvelope>>;
  create(input: {
    readonly plan: DeliveryPlan;
    readonly content: DeliveryContentCheck;
  }): Promise<Result<DeliveryCreateResult, ErrorEnvelope>>;
  enqueue(
    outbox: DeliveryOutboxEnqueue<"delivery.dispatch">
  ): Promise<Result<string, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Dependency bundle and outcome                                       */
/* ------------------------------------------------------------------ */

export interface OnlinePipelineDeps {
  /** Wall-clock source for persisted `*_at` fields and identifier timestamps. */
  readonly now: () => number;
  /**
   * Monotonic clock for EVD/Jev deadlines and elapsed measurement. A value
   * supplied as `evd.deadline_at_monotonic_ms` must live on this clock's
   * timeline. Defaults to the shared production `systemClock`; callers that
   * inject a fake `now` should inject the matching clock here.
   */
  readonly clock?: Clock;
  readonly host: HostPipelinePort;
  /** HOST capability records. Absence fails closed before an automatic review. */
  readonly capability?: CapabilityPipelinePort;
  /** HOST human proof; required only for a human-attested explicit request. */
  readonly proof?: OriginProofPort;
  readonly admission: {
    readonly review: ReviewSchedulerPort;
    readonly commit: StateRowLiveCommitPort;
  };
  readonly pending?: PendingPipelinePort;
  readonly progress?: ProgressPipelinePort;
  readonly budget?: BudgetAvailabilityPort;
  readonly qp: QpPipelineDeps;
  readonly evd: EvdPipelineDeps;
  readonly jev: JevPipelineDeps;
  readonly aggregator: AnswerAggregator;
  /**
   * Deterministic dispatch short-circuit (W3). Absence means `off`, which is
   * byte-for-byte the classic full dispatch.
   */
  readonly dispatch?: DispatchPipelineOptions;
  /**
   * Targeted evidence supplementation (W4). Absence means the classic
   * `needs_evidence` handling with no hook call.
   */
  readonly evidence_supplement?: SupplementPipelineOptions;
  readonly close_evidence?: CloseEvidencePipelinePort;
  readonly decision: DecisionRecordPort;
  readonly decision_inputs: DecisionInputsPipelinePort;
  readonly delivery?: DeliveryPipelinePort;
  /** Optional diagnostic sink; never used for control flow. */
  readonly on_diagnostic?: (message: string, error?: ErrorEnvelope) => void;
}

/**
 * Downstream dependency bundle.
 *
 * The EVD → Jev → aggregate → judgment → decision → delivery tail needs no
 * HOST, admission, pending-progress or capability seam, so callers that have
 * already admitted an event and run QP can reuse it without re-running either
 * stage.
 */
export type OnlineDownstreamDeps = Pick<
  OnlinePipelineDeps,
  | "now"
  | "clock"
  | "qp"
  | "evd"
  | "jev"
  | "aggregator"
  | "dispatch"
  | "evidence_supplement"
  | "close_evidence"
  | "decision"
  | "decision_inputs"
  | "delivery"
  | "on_diagnostic"
>;

export interface OnlineDownstreamQp {
  readonly issues: readonly OnlineIssue[];
  readonly plans: readonly OnlineQuestionPlan[];
  readonly plan_states: ReadonlyMap<string, OnlinePlanState>;
}

export interface OnlineDownstreamInput {
  /**
   * Outcome of admission. Its stages, diagnostics and trigger identity are
   * carried into the final outcome; downstream content comes from `qp`.
   */
  readonly admitted: OnlinePipelineOutcome;
  readonly qp: OnlineDownstreamQp;
}

export interface OnlinePipelineOutcome {
  readonly status: "completed" | "no_op" | "deferred";
  readonly stages: readonly OnlinePipelineStage[];
  readonly decision: TriggerDecision;
  readonly trigger_event_id: Id<"trg"> | null;
  readonly review_job_id: Id<"job"> | null;
  readonly issues: readonly OnlineIssue[];
  readonly plans: readonly OnlineQuestionPlan[];
  readonly packs: readonly EvidencePack[];
  readonly shard_plans: readonly ShardPlan[];
  readonly bindings: readonly JudgeRequestBindingV3[];
  readonly envelopes: readonly JudgeEnvelopeV3[];
  readonly aggregates: readonly AnswerAggregateV2[];
  readonly decision_ids: readonly Id<"dec">[];
  readonly delivery_ids: readonly Id<"del">[];
  readonly outbox_effect_keys: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface OnlinePipeline {
  run(
    event: CommittedHostEvent,
    options?: { readonly signal?: AbortSignal }
  ): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

interface PipelineErrorInput {
  readonly code: `E_${string}`;
  readonly category: ErrorEnvelope["category"];
  readonly stage: OnlinePipelineStage;
  readonly message_key: string;
  readonly details: ErrorDetails;
  readonly retryable?: boolean;
  readonly side_effect?: ErrorEnvelope["side_effect"];
}

function pipelineError(input: PipelineErrorInput): ErrorEnvelope {
  return makeErrorEnvelope({
    code: input.code,
    category: input.category,
    message_key: input.message_key,
    stage: input.stage,
    details: input.details,
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    ...(input.side_effect === undefined ? {} : { side_effect: input.side_effect })
  });
}

function rejected(stage: OnlinePipelineStage, incident: string): ErrorEnvelope {
  return pipelineError({
    code: "E_INTERNAL",
    category: "internal",
    stage,
    message_key: "error.internal.unexpected",
    details: { kind: "internal", incident_id: incident }
  });
}

function capabilityUnavailable(stage: OnlinePipelineStage): ErrorEnvelope {
  return pipelineError({
    code: "E_CAPABILITY",
    category: "policy",
    stage,
    message_key: "error.capability.unavailable",
    details: { kind: "internal", incident_id: "online_pipeline.capability_unavailable" }
  });
}

function proofUnavailable(stage: OnlinePipelineStage): ErrorEnvelope {
  return pipelineError({
    code: "E_AUTH_UNAVAILABLE",
    category: "authorization",
    stage,
    message_key: "error.auth.unavailable",
    details: { kind: "internal", incident_id: "online_pipeline.proof_unavailable" }
  });
}

function withSideEffect(
  error: ErrorEnvelope,
  side_effect: ErrorEnvelope["side_effect"]
): ErrorEnvelope {
  return { ...error, side_effect };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_DETECTOR_VERSION = "qp.issue_detector/1";
const DEFAULT_PLANNER_VERSION = "qp.planner/1";
const DEFAULT_COMPILER_VERSION = "evd-compiler/1";
const DEFAULT_COUNTING_METHOD_VERSION = "utf8-bytes/1";

function bindingFromReceipt(receipt: IngestReceipt): VersionBinding {
  return {
    task_id: receipt.task_id as Id<"task">,
    branch_id: receipt.branch_id as Id<"br">,
    input_epoch: receipt.input_epoch ?? 1,
    goal_version: receipt.goal_version,
    config_version: receipt.config_version,
    watermark: receipt.watermark
  };
}

function hostBinding(
  facts: HostTriggerFacts,
  event: CommittedHostEvent,
  now: number
): HostEventBinding {
  const draft = event.draft;
  return {
    host_id: facts.adapter.host_id,
    host_version: facts.adapter.host_version,
    adapter_id: facts.adapter.adapter_id,
    adapter_version: facts.adapter.adapter_version,
    implementation_hash: facts.adapter.implementation_hash,
    mode: draft.mode,
    config_space: draft.config_space,
    host_event: draft.host_event,
    ...(draft.native_session_id === undefined
      ? {}
      : { native_session_id: draft.native_session_id }),
    ...(draft.native_message_id === undefined
      ? {}
      : { native_message_id: draft.native_message_id }),
    ...(draft.native_event_id === undefined ? {} : { native_event_id: draft.native_event_id }),
    stream_id: facts.adapter.stream_id,
    ...(facts.adapter.source_seq === undefined ? {} : { source_seq: facts.adapter.source_seq }),
    receipt_seq: event.receipt.watermark,
    ...(facts.adapter.native_occurrence_id === undefined
      ? {}
      : { native_occurrence_id: facts.adapter.native_occurrence_id }),
    ...(facts.adapter.retry_of === undefined ? {} : { retry_of: facts.adapter.retry_of }),
    event_identity_key: facts.adapter.event_identity_key,
    ...(facts.adapter.occurred_at === undefined
      ? {}
      : { occurred_at: facts.adapter.occurred_at }),
    received_at: now
  };
}

function stableSnapshot(
  facts: HostTriggerFacts
): ReviewEnqueueRequest["snapshot_request"] | null {
  if (facts.boundary.stable && facts.boundary.pending_state === "none") {
    return { mode: "stable", completeness: "complete", missing_evidence_refs: [] };
  }
  const refs = facts.staged_missing_refs;
  if (refs === undefined || refs.length === 0) {
    return null;
  }
  return {
    mode: "explicit_stage",
    completeness: "staged_with_gaps",
    missing_evidence_refs: [refs[0], ...refs.slice(1)]
  };
}

function reviewRequest(input: {
  readonly event: CommittedHostEvent;
  readonly facts: HostTriggerFacts;
  readonly trigger: TriggerEvent;
  readonly policy: TriggerPolicy;
  readonly capability_snapshot_hash: Hash;
  readonly pending: readonly PendingChange[];
  readonly now: number;
}): Result<ReviewEnqueueRequest, ErrorEnvelope> {
  const { facts, trigger, policy, event } = input;
  const snapshot = stableSnapshot(facts);
  if (snapshot === null) {
    return err(
      pipelineError({
        code: "E_SCHEMA",
        category: "schema",
        stage: "trigger_admission",
        message_key: "error.schema.invalid",
        details: { kind: "field", path: "boundary.staged_missing_refs", rule: "required" }
      })
    );
  }
  const common = {
    schema_version: "rsi.review_enqueue/1" as const,
    request_id: newId("jreq", input.now),
    trigger_event_id: trigger.trigger_event_id,
    trigger_kind: trigger.trigger_kind,
    review_scope_key: trigger.review_scope_key,
    boundary_key: trigger.dedupe.boundary_key,
    signal_digest: trigger.dedupe.signal_digest,
    trigger_dedupe_key: trigger.dedupe.trigger_dedupe_key,
    stable_event_ids: [...trigger.boundary.stable_event_ids],
    stable_watermark: trigger.boundary.stable_watermark,
    goal_version: trigger.boundary.goal_version,
    scope: trigger.scope,
    pending_state: trigger.boundary.pending_state,
    pending_work_refs: [...trigger.boundary.pending_work_refs],
    stable: trigger.boundary.stable,
    stable_evidence_ref: trigger.stable_evidence_ref ?? facts.source_event_ref,
    policy_ref: trigger.policy_ref,
    origin: trigger.origin,
    capability_snapshot_hash: input.capability_snapshot_hash,
    budget_policy_ref: policy.budget.budget_policy_ref,
    created_at: input.now
  };
  if (trigger.request_intent === "explicit_review") {
    if (facts.authorization_ref === null) {
      return err(
        pipelineError({
          code: "E_AUTH_DENIED",
          category: "authorization",
          stage: "trigger_admission",
          message_key: "error.auth.denied",
          details: {
            kind: "authorization",
            object_type: "review_job",
            denied_dimension: "action"
          }
        })
      );
    }
    if (snapshot.mode === "stable") {
      return ok({
        ...common,
        review_kind: "explicit",
        authorization_ref: facts.authorization_ref,
        stable: true,
        pending_state: "none",
        pending_work_refs: [],
        snapshot_request: snapshot
      });
    }
    return ok({
      ...common,
      review_kind: "explicit",
      authorization_ref: facts.authorization_ref,
      stable: false,
      snapshot_request: snapshot
    });
  }
  if (snapshot.mode !== "stable") {
    return err(
      pipelineError({
        code: "E_SCHEMA",
        category: "schema",
        stage: "trigger_admission",
        message_key: "error.schema.invalid",
        details: { kind: "field", path: "boundary.stable", rule: "required_for_auto" }
      })
    );
  }
  return ok({
    ...common,
    review_kind: "auto",
    authorization_ref: null,
    stable: true,
    pending_state: "none",
    pending_work_refs: [],
    snapshot_request: snapshot
  });
}

function triggerEvent(input: {
  readonly facts: HostTriggerFacts;
  readonly event: CommittedHostEvent;
  readonly policy: TriggerPolicy;
  readonly decision: TriggerDecision;
  readonly capability_gate: readonly CapabilityGateResult[];
  readonly now: number;
  readonly pending_ref?: Id<"pen">;
}): TriggerEvent {
  const { facts } = input;
  return {
    schema_version: "rsi.trigger_event/1",
    trigger_event_id: newId("trg", input.now),
    trigger_kind: facts.trigger_kind,
    source_event_ref: facts.source_event_ref,
    raw_event_ref: facts.raw_event_ref,
    ...(input.event.receipt.input_id === undefined
      ? {}
      : { local_input_id: input.event.receipt.input_id as Id<"input"> }),
    host_binding: hostBinding(facts, input.event, input.now),
    policy_ref: {
      policy_id: input.policy.policy_id,
      policy_version: input.policy.policy_version,
      policy_hash: input.policy.policy_hash,
      scope_key: policyScopeKey(input.policy)
    },
    origin: facts.origin,
    request_intent: facts.request_intent,
    scope: facts.scope,
    identity_quality: facts.identity_quality,
    signals: [...facts.signals],
    boundary: facts.boundary,
    ...(facts.stable_evidence_ref === undefined
      ? {}
      : { stable_evidence_ref: facts.stable_evidence_ref }),
    review_scope_key: facts.review_scope_key,
    capability_gate: [...input.capability_gate],
    dedupe: facts.dedupe,
    decision: input.decision.decision,
    decision_reason: input.decision.reason,
    ...(input.pending_ref === undefined ? {} : { pending_ref: input.pending_ref }),
    policy_snapshot_ref: facts.policy_snapshot_ref,
    decision_version: 1,
    decided_at: input.now,
    evidence_refs: [...facts.evidence_refs]
  };
}

function policyScopeKey(policy: TriggerPolicy): Hash {
  const scope = policy.scope;
  return canonicalHash({
    scope_kind: scope.scope_kind,
    host_id: scope.host_id ?? null,
    mode: scope.mode ?? null,
    config_space: scope.config_space ?? null,
    project_id: scope.project_id ?? null
  });
}

function requiredCapabilities(intent: "automatic" | "explicit_review"): readonly CapabilityName[] {
  return intent === "automatic" ? ["stable_boundary"] : [];
}

function capabilityGate(
  capability: CapabilityPipelinePort,
  facts: HostTriggerFacts
): Result<readonly CapabilityGateResult[], ErrorEnvelope> {
  const required = requiredCapabilities(facts.request_intent);
  if (required.length === 0) {
    return ok([]);
  }
  const entries = required.map((name) => {
    const observed = capability.lookup(name);
    return {
      name,
      status: observed?.status ?? "unknown",
      evidence_stage: observed?.evidence_stage ?? "none"
    };
  });
  const gate = buildCapabilityGate(
    entries.map((entry) => entry.name),
    (name) => {
      const entry = entries.find((candidate) => candidate.name === name);
      return entry === undefined
        ? { status: "unknown", evidence_stage: "none" }
        : { status: entry.status, evidence_stage: entry.evidence_stage };
    }
  );
  return ok(gate);
}

function decide(
  deps: OnlinePipelineDeps,
  facts: HostTriggerFacts,
  policy: TriggerPolicy,
  gate: readonly CapabilityGateResult[],
  budgetAvailable: boolean
): TriggerDecision {
  if (facts.request_intent === "explicit_review") {
    return decideExplicit({
      origin: facts.origin,
      boundary: facts.boundary,
      authorizationRef: facts.authorization_ref,
      stage: facts.stage,
      liveJob: facts.job_live,
      replayDuplicate: facts.replay_duplicate,
      policy
    });
  }
  return decideAutomatic({
    origin: facts.origin,
    boundary: facts.boundary,
    signals: facts.signals,
    stableBoundaryStatus:
      gate.find((entry) => entry.name === "stable_boundary")?.observed_status ?? "unknown",
    liveJob: facts.job_live,
    replayDuplicate: facts.replay_duplicate,
    autoQuotaExhausted: facts.auto_quota_exhausted,
    budgetAvailable: capabilityGatePassed(gate) && budgetAvailable,
    policy
  });
}

/* ------------------------------------------------------------------ */
/* Trigger stage                                                       */
/* ------------------------------------------------------------------ */

interface TriggerStageResult {
  readonly kind: "enqueue" | "no_op" | "deferred";
  readonly decision: TriggerDecision;
  readonly trigger_event_id: Id<"trg"> | null;
  readonly review_job_id: Id<"job"> | null;
  readonly trigger: TriggerEvent | null;
  readonly pending: readonly PendingChange[];
}

async function runTriggerStage(
  deps: OnlinePipelineDeps,
  event: CommittedHostEvent
): Promise<Result<TriggerStageResult, ErrorEnvelope>> {
  if (event.receipt.duplicate) {
    return ok({
      kind: "no_op",
      decision: { decision: "skip", reason: "replay_duplicate", staged: false },
      trigger_event_id: null,
      review_job_id: null,
      trigger: null,
      pending: []
    });
  }
  const factsResult = await deps.host.facts(event);
  if (!factsResult.ok) {
    return err(factsResult.error);
  }
  const facts = factsResult.value;
  const policyResult = await deps.host.policy(event);
  if (!policyResult.ok) {
    return err(policyResult.error);
  }
  const resolved = policyResult.value;
  if (resolved === null) {
    return ok({
      kind: "no_op",
      decision: { decision: "skip", reason: "policy_auto_disabled", staged: false },
      trigger_event_id: null,
      review_job_id: null,
      trigger: null,
      pending: []
    });
  }
  const capability = deps.capability;
  if (capability === undefined) {
    return err(capabilityUnavailable("trigger_policy"));
  }
  const gateResult = capabilityGate(capability, facts);
  if (!gateResult.ok) {
    return err(gateResult.error);
  }
  const snapshotHash = capability.snapshotHash();
  if (!snapshotHash.ok) {
    return err(snapshotHash.error);
  }

  if (facts.origin.kind === "human" && facts.request_intent === "explicit_review") {
    if (deps.proof === undefined) {
      return err(proofUnavailable("trigger_policy"));
    }
    if (facts.human_attestation !== undefined) {
      const parsedRef = parseSourceRef(facts.human_attestation.evidence_ref);
      if (!parsedRef.ok || !isId(facts.human_attestation.capability_id, "cap")) {
        return err(proofUnavailable("trigger_policy"));
      }
      const verdict = await deps.proof.verifyHuman({
        attestation: {
          schema_version: "rsi.human_attestation/1",
          kind: facts.human_attestation.kind,
          capability_id: facts.human_attestation.capability_id,
          evidence_ref: parsedRef.value.source_ref,
          confirmed_at: facts.human_attestation.confirmed_at
        },
        host_id: event.draft.host_id,
        config_space: event.draft.config_space,
        native_session_id: event.draft.native_session_id,
        event_key: event.receipt.event_key as Hash
      });
      if (verdict !== "verified") {
        return err(proofUnavailable("trigger_policy"));
      }
    }
  }

  let budgetAvailable = false;
  if (deps.budget !== undefined) {
    const available = await deps.budget.available();
    if (available.ok) {
      budgetAvailable = available.value;
    }
  }

  const decision = decide(deps, facts, resolved, gateResult.value, budgetAvailable);
  const pendingResult = await deps.host.pending(event, facts, decision);
  if (!pendingResult.ok) {
    return err(pendingResult.error);
  }
  const pending = pendingResult.value;

  if (decision.decision === "defer") {
    if (deps.pending !== undefined && pending.length > 0) {
      const persisted = await deps.pending.commit({ binding: event.binding, changes: pending });
      if (!persisted.ok) {
        return err(persisted.error);
      }
    }
    return ok({
      kind: "deferred",
      decision,
      trigger_event_id: null,
      review_job_id: null,
      trigger: null,
      pending
    });
  }

  const trigger = triggerEvent({
    facts,
    event,
    policy: resolved,
    decision,
    capability_gate: gateResult.value,
    now: deps.now()
  });

  if (decision.decision !== "enqueue") {
    return ok({
      kind: "no_op",
      decision,
      trigger_event_id: trigger.trigger_event_id,
      review_job_id: null,
      trigger,
      pending
    });
  }

  const reqResult = reviewRequest({
    event,
    facts,
    trigger,
    policy: resolved,
    capability_snapshot_hash: snapshotHash.value,
    pending,
    now: deps.now()
  });
  if (!reqResult.ok) {
    return err(reqResult.error);
  }
  const admission = await admitTrigger(
    {
      trigger,
      req: reqResult.value,
      binding: event.binding,
      pending
    },
    { review: deps.admission.review, commit: deps.admission.commit }
  );
  if (!admission.ok) {
    return err(admission.error);
  }

  const reviewJob = admission.value.review?.review_job_id ?? null;

  if (deps.progress !== undefined && resolved.progress.enabled) {
    const progress = await deps.progress.ensure({ event, trigger, decision });
    if (!progress.ok) {
      return err(withSideEffect(progress.error, "committed"));
    }
  }

  return ok({
    kind: "enqueue",
    decision,
    trigger_event_id: admission.value.trigger_event_id,
    review_job_id: reviewJob,
    trigger: {
      ...trigger,
      ...(reviewJob === null ? {} : { review_job_id: reviewJob })
    },
    pending
  });
}

/* ------------------------------------------------------------------ */
/* QP stage                                                            */
/* ------------------------------------------------------------------ */

interface QpStageResult {
  readonly planner: QpPlannerPort;
  readonly issues: readonly OnlineIssue[];
  readonly plans: readonly OnlineQuestionPlan[];
  readonly plan_states: ReadonlyMap<string, OnlinePlanState>;
  readonly no_op_reason: string | null;
  readonly deferred: boolean;
}

function failureCode(errors: ReadonlyArray<{ readonly code: string }>): string {
  return errors[0]?.code ?? "E_INTERNAL";
}

async function runQpStage(
  deps: OnlinePipelineDeps,
  event: CommittedHostEvent
): Promise<Result<QpStageResult, ErrorEnvelope>> {
  const planner = deps.qp.planner;
  const progressFrom = deps.qp.progress_from_watermark ?? event.binding.watermark;
  const discovery = planner.discover({
    binding: event.binding,
    watermark: event.binding.watermark,
    progress_from_watermark: progressFrom,
    policy_version: deps.qp.detector_version ?? DEFAULT_DETECTOR_VERSION
  });
  if (discovery.status === "rejected") {
    return err(
      rejected("issue_discovery", `online_pipeline.issue_discovery:${failureCode(discovery.errors)}`)
    );
  }
  if (discovery.issues.length === 0) {
    return ok({
      planner,
      issues: [],
      plans: [],
      plan_states: new Map(),
      no_op_reason: "no_issue",
      deferred: false
    });
  }

  const issues: OnlineIssue[] = [];
  const plans: OnlineQuestionPlan[] = [];
  const planStates = new Map<string, OnlinePlanState>();
  let deferred = false;
  let lastReason = "no_issue";

  for (const issue of discovery.issues) {
    const planned = planner.plan({
      binding: event.binding,
      issue,
      registry: deps.qp.registry,
      policy_version: deps.qp.planner_version ?? DEFAULT_PLANNER_VERSION
    });
    if (planned.status === "planned") {
      issues.push(issue);
      plans.push(planned.plan);
      // Lifecycle is a persisted fact. A structural planner that omits it must
      // leave resolution to the injected lifecycle reader; this stage never
      // fabricates `active`.
      if (planned.plan_state !== undefined) {
        planStates.set(planned.plan.plan_id, planned.plan_state);
      }
      continue;
    }
    lastReason = planned.reason;
    if (planned.status === "deferred") {
      deferred = true;
    }
    if (planned.status === "rejected") {
      return err(
        rejected("issue_plan", `online_pipeline.issue_plan:${planned.reason}:${planned.issue_id}`)
      );
    }
  }

  if (plans.length === 0) {
    return ok({
      planner,
      issues,
      plans,
      plan_states: planStates,
      no_op_reason: lastReason,
      deferred
    });
  }
  return ok({ planner, issues, plans, plan_states: planStates, no_op_reason: null, deferred });
}

/* ------------------------------------------------------------------ */
/* EVD stage                                                           */
/* ------------------------------------------------------------------ */

interface CompiledPlan {
  readonly pack: EvidencePack;
  readonly shard_plan: ShardPlan;
  readonly bindings: readonly JudgeRequestBindingV3[];
  /**
   * W3 decision for this plan. `null` when the short-circuit is off, so a
   * default composition never reads a snapshot or synthesises a decision.
   */
  readonly dispatch: PlanDispatchDecision | null;
  /** Shards whose required questions are all settled (enforce mode only). */
  readonly skipped_shard_keys: readonly string[];
  /** Questions proved by verified hard facts; re-validated by the reducer. */
  readonly decided_question_keys: readonly string[];
}

function writeResultOk(result: { readonly ok: boolean }): boolean {
  return result.ok;
}

/**
 * Resolves an EVD plan lifecycle without inventing one.
 *
 * The planner's per-plan state is authoritative for plans it just produced.
 * When a plan is absent from that map, an injected QP `PlanReadPort` is the
 * only other source; with neither source the plan is refused as
 * `E_PLAN_NOT_FOUND` instead of being synthesised as `active`.
 */
export function createOnlinePlanStateReadPort(input: {
  readonly plan_states: ReadonlyMap<string, OnlinePlanState>;
  readonly read_plan: EvidencePlanReadPort;
  readonly lifecycle?: PlanReadPort;
}): PlanReadPort {
  return {
    async readPlanForAggregate(query) {
      let state = input.plan_states.get(query.plan_id);
      if (state === undefined && input.lifecycle !== undefined) {
        const lifecycle = await input.lifecycle.readPlanForAggregate(query);
        if (!lifecycle.ok) {
          return lifecycle;
        }
        state = lifecycle.value.plan_state;
      }
      if (state === undefined) {
        return {
          ok: false,
          code: "E_PLAN_NOT_FOUND",
          error: qpFailure("E_PLAN_NOT_FOUND", "plan_state", {
            path: "plan_state",
            rule: "state_required"
          })
        };
      }
      const read = await input.read_plan.readPlan({
        plan_id: query.plan_id,
        plan_hash: query.expected_plan_hash,
        binding: query.binding
      });
      if (!read.ok) {
        return { ok: false, code: read.error.code, error: read.error };
      }
      const plan = read.value;
      const view: AggregatePlanView = {
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        issue_id: plan.issue_id,
        issue_key: plan.issue_key,
        binding: plan.binding,
        plan_state: state,
        state_profile: plan.state_profile,
        aggregate_output_reserve_tokens: plan.aggregate_output_reserve_tokens,
        questions: plan.questions.map((question) => ({
          question_key: question.question_key,
          question_type: question.question_type,
          template_id: question.template_id,
          template_version: question.template_version,
          template_hash: question.template_hash,
          options: question.options,
          criteria: question.criteria,
          instructions: question.instructions,
          required_for_issue: question.required_for_issue,
          proposition_id: question.proposition_id,
          requirement_ids: question.requirement_ids,
          option_effects: question.option_effects,
          answer_to_issue_map: question.answer_to_issue_map,
          independence: question.independence
        }))
      };
      return { ok: true, value: view };
    }
  };
}

function pipelineClock(deps: OnlineDownstreamDeps): Clock {
  return deps.clock ?? systemClock;
}

/**
 * Absolute deadline for the EVD request budget.
 *
 * The value lives on the clock's monotonic timeline and is floored to the
 * safe-integer domain the compiler accepts. Flooring only shortens the budget;
 * wall-clock movement cannot change it.
 */
export function deadlineAtMonotonic(
  clock: Pick<Clock, "monotonicNowMs">,
  remaining_ms: number
): number {
  return Math.floor(clock.monotonicNowMs() + remaining_ms);
}

/**
 * The read-only plan shape the dispatch layer needs. It is structurally
 * satisfied by the core `QuestionPlan` returned by `readPlan`, so the kernel
 * never converts or duplicates the plan record.
 */
interface DispatchPlanSource {
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly binding: VersionBinding;
  readonly questions: ReadonlyArray<{
    readonly question_key: string;
    readonly proposition_id: string;
    readonly requirement_ids: readonly string[];
    readonly required_for_issue: boolean;
  }>;
}

/**
 * Structural projection of the EVD plan for `decidePlanDispatch`.
 *
 * The plan view is the same plan record the compiler already read, so no
 * question, proposition or requirement identity is invented here.
 */
function dispatchPlanView(plan: DispatchPlanSource): DispatchPlanView {
  return {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash as Hash,
    binding: plan.binding,
    questions: plan.questions.map((question) => ({
      question_key: question.question_key,
      proposition_id: question.proposition_id,
      requirement_ids: question.requirement_ids,
      required_for_issue: question.required_for_issue
    }))
  };
}

/**
 * Verified hard facts of the frozen snapshot. `listHardFacts` only returns
 * verified rows; the explicit `verified` copy keeps the decision layer honest
 * even if that ever changes.
 */
function dispatchFacts(snapshot: EvidenceIndexSnapshot): readonly DispatchHardFactView[] {
  return snapshot
    .listHardFacts({ binding: snapshot.binding, watermark: snapshot.watermark })
    .map((fact) => ({
      fact_key: fact.fact_key,
      independence_key: fact.independence_key,
      requirement_id: fact.requirement_id,
      ...(fact.proposition_id === undefined ? {} : { proposition_id: fact.proposition_id }),
      effect: fact.effect,
      verified: fact.verified
    }));
}

/**
 * Coverage-gap hints per question. A coverage entry affects every question
 * that names its requirement; `conflicting_sources` reaches the decision as an
 * ambiguity hint rather than a gap.
 */
function dispatchEvidenceByQuestion(
  plan: DispatchPlanSource,
  snapshot: EvidenceIndexSnapshot
): Readonly<Record<string, DispatchEvidenceView>> {
  const coverage = snapshot.getCoverageSnapshot({
    binding: snapshot.binding,
    watermark: snapshot.watermark
  });
  const result: Record<string, DispatchEvidenceView> = {};
  for (const question of plan.questions) {
    const requirements = new Set(question.requirement_ids);
    const codes = coverage.missing
      .filter((entry) => requirements.has(entry.requirement_id))
      .map((entry) => entry.code);
    if (codes.length > 0) {
      result[question.question_key] = { gap_codes: codes };
    }
  }
  return result;
}

/**
 * A shard may be skipped only when every question on it has a decision and
 * none of them needs the semantic backend. An unknown question keeps the
 * shard dispatchable, so missing plan data can never hide a dispatch.
 */
function shardSettled(shard: Shard, decision: PlanDispatchDecision): boolean {
  const byKey = new Map(decision.questions.map((entry) => [entry.question_key, entry.decision]));
  return (
    shard.question_keys.length > 0 &&
    shard.question_keys.every((questionKey) => {
      const settled = byKey.get(questionKey);
      return settled !== undefined && settled.kind !== "semantic_required";
    })
  );
}

/**
 * Marks a settled shard and records why it never reached the semantic
 * backend.
 *
 * The shard row keeps the closed `deterministic_skip` status, carries no
 * request binding, manifest or envelope, and its omission row names the
 * skipped questions so the aggregate can tell a skip apart from a lost shard.
 */
function skipShard(
  shard: Shard,
  plan: ShardPlan,
  decision: PlanDispatchDecision,
  now: number
): { readonly shard: Shard; readonly omission: Omission } {
  const questionKeys = [...shard.question_keys].sort();
  const requiredByQuestion = new Map(
    decision.questions.map((entry) => [entry.question_key, entry.required_for_issue])
  );
  // A shard may carry optional questions only. Skipping it is not a blocking
  // omission then; the omission row still exists so the skip is durable.
  const required = questionKeys.some((key) => requiredByQuestion.get(key) === true);
  const impact = required ? "blocking" : "none";
  const planImpact = required ? "answer_changing" : "none";
  const key = omissionKey({
    plan_hash: plan.plan_hash,
    unit_keys: [],
    question_keys: questionKeys,
    source_ids: [],
    source_refs: [],
    plan_omission_impact: planImpact,
    can_omit: false,
    required_for_issue: required,
    reason: "deterministic_skip",
    impact
  });
  const omission: Omission = {
    schema_version: "rsi.evidence_omission/1",
    omission_id: newId("omis"),
    omission_key: key,
    shard_plan_id: plan.shard_plan_id,
    plan_hash: plan.plan_hash,
    shard_id: shard.shard_id,
    question_ids: [...shard.question_ids],
    question_keys: questionKeys,
    unit_keys: [],
    source_ids: [],
    source_refs: [],
    plan_omission_impact: planImpact,
    can_omit: false,
    required_for_issue: required,
    reason: "deterministic_skip",
    impact,
    recoverable: true,
    recorded_by: "evd-dispatch/1",
    created_at: now
  };
  return {
    shard: {
      ...shard,
      status: "deterministic_skip",
      request_binding_id: null,
      omission_ids: [...shard.omission_ids, omission.omission_id],
      reason_codes: [...new Set([...shard.reason_codes, "deterministic_skip"])]
    },
    omission
  };
}

async function runEvdStage(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  plans: readonly OnlineQuestionPlan[],
  planStates: ReadonlyMap<string, OnlinePlanState>,
  note: (message: string) => void
): Promise<Result<readonly CompiledPlan[], ErrorEnvelope>> {
  const evd = deps.evd;
  const clock = pipelineClock(deps);
  const compiler = createEvidenceCompiler({
    plans: evd.plans,
    plan_states: createOnlinePlanStateReadPort({
      plan_states: planStates,
      read_plan: evd.plans,
      ...(evd.plan_lifecycle === undefined ? {} : { lifecycle: evd.plan_lifecycle })
    }),
    issues: evd.issues,
    now: deps.now,
    monotonic_now: () => clock.monotonicNowMs(),
    ...(evd.binding === undefined ? {} : { binding: evd.binding })
  });
  const snapshot = deps.qp.planner.deps.evidence;
  const compiled: CompiledPlan[] = [];
  const dispatchAudit = resolveDispatchAuditPort(deps.dispatch, deps.now);

  for (const plan of plans) {
    const planId = plan.plan_id as Id;
    const planHash = plan.plan_hash as Hash;
    const issueId = plan.issue_id as Id;

    const packResult = await compiler.compilePack({
      schema_version: "rsi.pack_compile_input/1",
      plan_id: planId,
      plan_hash: planHash,
      issue_id: issueId,
      issue_key: plan.issue_key,
      binding: plan.binding,
      snapshot,
      service_profile_key: evd.service_profile_key,
      limits: evd.limits,
      compiler_version: evd.compiler_version ?? DEFAULT_COMPILER_VERSION,
      counting_method_version: evd.counting_method_version ?? DEFAULT_COUNTING_METHOD_VERSION
    });
    if (!packResult.ok) {
      return err(packResult.error);
    }
    const { pack, units } = packResult.value;

    const required = plan.questions.filter((question) => question.required_for_issue);
    const optional = plan.questions.filter((question) => !question.required_for_issue);
    const closure = compiler.expandClosure({
      schema_version: "rsi.closure_input/1",
      plan_id: planId,
      plan_hash: planHash,
      pack_key: pack.pack_key,
      required_question_keys: required.map((question) => question.question_key),
      optional_question_keys: optional.map((question) => question.question_key),
      units,
      limits: evd.limits
    });
    if (!closure.ok) {
      return err(closure.error);
    }

    const readPlan = await evd.plans.readPlan({
      plan_id: planId,
      plan_hash: planHash,
      binding: plan.binding
    });
    if (!readPlan.ok) {
      return err(readPlan.error);
    }
    const evidencePlan = readPlan.value;

    // W3: decide once per plan, before any request is built. `off` keeps the
    // decision absent so the classic path is untouched.
    const dispatchOption = deps.dispatch;
    const dispatchMode = dispatchOption?.mode ?? "off";
    const dispatchDecision: PlanDispatchDecision | null =
      dispatchMode === "off"
        ? null
        : decidePlanDispatch(
            dispatchPlanView(evidencePlan),
            event.binding,
            dispatchFacts(snapshot),
            dispatchEvidenceByQuestion(evidencePlan, snapshot)
          );

    const shards = await compiler.planShards({
      schema_version: "rsi.shard_plan_input/1",
      plan_id: planId,
      plan_hash: planHash,
      issue_id: issueId,
      issue_key: plan.issue_key,
      pack,
      pack_key: pack.pack_key,
      closure: closure.value,
      snapshot,
      service_profile: evd.service_profile,
      limits: evd.limits,
      binding: plan.binding,
      shard_policy_version: "per_shard/1"
    });
    if (!shards.ok) {
      return err(shards.error);
    }
    const plannedShards = shards.value;

    // A settled shard is decided before its compile batch is written, so the
    // same append carries its terminal `deterministic_skip` status and the
    // omission row that names the skipped questions.
    const settledShardKeys: string[] = [];
    for (const shard of plannedShards.shards) {
      if (shard.status === "budget_rejected") {
        continue;
      }
      if (dispatchDecision !== null && shardSettled(shard, dispatchDecision)) {
        settledShardKeys.push(shard.shard_key);
      }
    }
    const skippedShardKeys: string[] =
      dispatchMode === "enforce" ? [...settledShardKeys] : [];
    const skippedSet = new Set(skippedShardKeys);
    const dispatchedShardKeys = plannedShards.shards
      .filter((shard) => shard.status !== "budget_rejected" && !skippedSet.has(shard.shard_key))
      .map((shard) => shard.shard_key);

    // Every skip decision is persisted before the first request is skipped.
    // `enforce` therefore requires a durable audit port and fails closed when
    // it is absent or rejects the record. The shard/omission rows are the
    // durable provenance; the audit record names the complete plan decision.
    if (dispatchDecision !== null) {
      const audit = dispatchAudit;
      if (dispatchMode === "enforce" && audit === undefined) {
        return err(
          pipelineError({
            code: "E_DISPATCH_AUDIT_UNAVAILABLE",
            category: "policy",
            stage: "evidence_binding",
            message_key: "error.dispatch.audit_unavailable",
            details: { kind: "none" }
          })
        );
      }
      if (audit !== undefined) {
        const audited = await audit.record({
          mode: dispatchMode,
          binding: event.binding,
          plan_id: plan.plan_id,
          decision: dispatchDecision,
          skipped_shard_keys: skippedShardKeys,
          dispatched_shard_keys: dispatchedShardKeys
        });
        if (!audited.ok) {
          if (dispatchMode === "enforce") {
            return err(audited.error);
          }
          note(`dispatch.audit_failed:${plan.plan_id}:${audited.error.code}`);
        } else if (dispatchMode === "enforce") {
          note(`dispatch.audit:${audited.value.audit_id}:${plan.plan_id}`);
        }
      }
      note(
        `dispatch.${dispatchMode}:plan=${plan.plan_id}:kind=${dispatchDecision.kind}:semantic=${dispatchDecision.semantic_question_keys.length}:decided=${dispatchDecision.decided_question_keys.length}:gap=${dispatchDecision.gap_question_keys.length}:settled_shards=${settledShardKeys.length}:skipped_shards=${skippedShardKeys.length}:dispatched_shards=${dispatchedShardKeys.length}`
      );
      note(
        `dispatch.${dispatchMode}:fact_keys=${dispatchDecision.fact_keys.length}:reason_codes=${dispatchDecision.reason_codes.join(",")}:policy=${dispatchDecision.policy_version}`
      );
    }

    const skipRows: Omission[] = [];
    const shardsForCommit: Shard[] =
      skippedSet.size === 0
        ? [...plannedShards.shards]
        : plannedShards.shards.map((shard) => {
            if (dispatchDecision === null || !skippedSet.has(shard.shard_key)) {
              return shard;
            }
            const skip = skipShard(shard, plannedShards.plan, dispatchDecision, deps.now());
            skipRows.push(skip.omission);
            return skip.shard;
          });
    const manifestsForCommit =
      skippedSet.size === 0
        ? plannedShards.manifests
        : plannedShards.manifests.filter(
            (manifest) => !skippedSet.has(manifest.shard_key)
          );

    const writeCompile = await evd.writer.commitCompile({
      binding: plan.binding,
      pack,
      units,
      manifests: manifestsForCommit,
      shard_plan: plannedShards.plan,
      shards: shardsForCommit,
      omissions: [...plannedShards.omissions, ...skipRows],
      estimates: plannedShards.estimates
    });
    if (!writeResultOk(writeCompile)) {
      return err(
        rejected("evidence_pack", "online_pipeline.evd_compile_not_written")
      );
    }

    const bindings: JudgeRequestBindingV3[] = [];
    for (const shard of plannedShards.shards) {
      if (shard.status === "budget_rejected" || skippedSet.has(shard.shard_key)) {
        continue;
      }
      const selected = evidencePlan.questions.filter((question) =>
        shard.question_keys.includes(question.question_key)
      );
      const built = await compiler.buildRequest({
        invocation_id: newId("jreq", deps.now()),
        plan_id: planId,
        plan_hash: planHash,
        question_ids: [...shard.question_keys],
        version_binding: plan.binding,
        pack_id: pack.pack_id,
        pack_key: pack.pack_key,
        shard_plan_id: plannedShards.plan.shard_plan_id,
        shard_id: shard.shard_id,
        backend: evd.backend,
        service_profile_id:
          "profile_id" in evd.service_profile ? evd.service_profile.profile_id : null,
        template_bindings: buildTemplateBindings(evidencePlan, selected),
        validator_binding_id: evd.validator_binding_id,
        budget: evd.limits,
        deadline_at_monotonic_ms:
          evd.deadline_at_monotonic_ms ??
          deadlineAtMonotonic(clock, evd.limits.deadline_ms),
        created_at: deps.now()
      });
      if (!built.ok) {
        return err(built.error);
      }
      const writeBinding = await evd.writer.commitBinding({
        binding: plan.binding,
        request_binding: built.value,
        shard_id: shard.shard_id,
        shard_plan_key: plannedShards.plan.shard_plan_key,
        validator_binding_key: evd.validator_binding_key
      });
      if (!writeResultOk(writeBinding)) {
        return err(
          rejected("evidence_binding", "online_pipeline.evd_binding_not_written")
        );
      }
      bindings.push(built.value);
    }

    const decidedQuestionKeys =
      dispatchMode === "enforce" && dispatchDecision !== null
        ? dispatchDecision.decided_question_keys
        : [];

    compiled.push({
      pack,
      shard_plan: plannedShards.plan,
      bindings,
      dispatch: dispatchDecision,
      skipped_shard_keys: skippedShardKeys,
      decided_question_keys: decidedQuestionKeys
    });
  }
  return ok(compiled);
}

/* ------------------------------------------------------------------ */
/* Jev stage                                                           */
/* ------------------------------------------------------------------ */

interface JevStageResult {
  readonly envelopes: readonly JudgeEnvelopeV3[];
}

/**
 * Adapts the EVD writer to the gateway's durable-attempt hooks.
 *
 * The gateway calls `prepare` and `markSending` before `backend.invoke`, so
 * these writes are the actual send-point barrier (DD-EVD-025), not a
 * post-dispatch bookkeeping step.
 */
function createGatewayAttemptPersistence(
  writer: EvdStateWritePort
): GatewayAttemptPersistence {
  return {
    prepare(input) {
      return writer.prepareAttempt({
        binding: input.binding,
        attempt: input.attempt
      });
    },
    markSending(input) {
      return writer.markSending(input);
    },
    commitResponse(input) {
      return writer.commitResponse(input);
    },
    commitTerminal(input) {
      return writer.commitAttemptTerminal(input);
    }
  };
}

/**
 * Builds the pipeline-owned gateway from the real EVD/Jev dependencies.
 *
 * The Jev service profile is the persisted profile instance selected by the
 * evidence composition. A semantic capability is not a service profile and
 * must not be passed through as one; only the discriminated
 * `rsi.jev_service_profile/1` row may reach the gateway.
 */
export function createPipelineJudgeGateway(
  deps: OnlineDownstreamDeps
): JudgeGateway | null {
  if (deps.jev.backend === undefined || deps.jev.late === undefined) {
    return null;
  }
  const serviceProfile = deps.evd.service_profile;
  const jevProfile =
    serviceProfile.schema_version === "rsi.jev_service_profile/1"
      ? serviceProfile
      : undefined;
  return createJudgeGateway({
    backend: deps.jev.backend,
    late: deps.jev.late,
    now: deps.now,
    clock: pipelineClock(deps),
    next_attempt_no: deps.jev.next_attempt_no ?? (() => 1),
    attempts: createGatewayAttemptPersistence(deps.evd.writer),
    // The profile object is passed by identity; the gateway only reads its
    // identity fields and never re-derives or fabricates a profile.
    ...(jevProfile === undefined ? {} : { jev_profile: jevProfile })
  });
}

async function runJevStage(
  deps: OnlineDownstreamDeps,
  bindings: readonly JudgeRequestBindingV3[],
  signal: AbortSignal
): Promise<Result<JevStageResult, ErrorEnvelope>> {
  const gateway = deps.jev.gateway ?? createPipelineJudgeGateway(deps);
  if (gateway === null) {
    return err(capabilityUnavailable("jev_dispatch"));
  }
  const budget = deps.jev.budget;
  if (budget === undefined) {
    return err(
      pipelineError({
        code: "E_BUDGET_UNKNOWN",
        category: "budget",
        stage: "jev_dispatch",
        message_key: "error.budget.unknown",
        details: {
          kind: "budget",
          scope_key: "",
          policy_version: "",
          budget_kind: "token",
          remaining: null
        }
      })
    );
  }
  const envelopes: JudgeEnvelopeV3[] = [];

  for (const binding of bindings) {
    if (signal.aborted) {
      return err(
        pipelineError({
          code: "E_CANCELLED",
          category: "deadline",
          stage: "jev_dispatch",
          message_key: "error.cancelled",
          details: { kind: "none" }
        })
      );
    }
    const attempt = await gateway.dispatch(binding, budget, signal);
    if (attempt.status === "rejected") {
      return err(attempt.error);
    }
    if (attempt.status === "unknown") {
      return err(withSideEffect(attempt.error, "unknown"));
    }
    if (attempt.status === "cancelled") {
      return err(attempt.error);
    }
    if (attempt.status === "late_result_appended") {
      return err(
        pipelineError({
          code: "E_CONFLICT",
          category: "conflict",
          stage: "jev_dispatch",
          message_key: "error.conflict",
          details: { kind: "none" }
        })
      );
    }

    // Durable attempt ordering lives inside the gateway: `prepared` and
    // `sending` are committed before the provider call, and the terminal row
    // is committed before this result reaches the pipeline.
    envelopes.push(attempt.envelope);
  }
  return ok({ envelopes });
}

/* ------------------------------------------------------------------ */
/* Aggregation stage                                                   */
/* ------------------------------------------------------------------ */

interface AggregateStageResult {
  readonly aggregates: readonly AnswerAggregateV2[];
}

async function runAggregateStage(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  issues: readonly OnlineIssue[],
  plans: readonly OnlineQuestionPlan[],
  compiled: readonly CompiledPlan[],
  note: (message: string) => void,
  signal: AbortSignal
): Promise<Result<AggregateStageResult, ErrorEnvelope>> {
  const snapshot = deps.qp.planner.deps.evidence;
  const aggregates: AnswerAggregateV2[] = [];

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const entry = compiled[index];
    const issue = issues.find((candidate) => candidate.issue_id === plan?.issue_id);
    if (plan === undefined || entry === undefined) {
      continue;
    }
    const request = {
      issue_id: plan.issue_id as Id,
      plan_id: plan.plan_id as Id,
      plan_hash: plan.plan_hash as Hash,
      shard_plan_id: entry.shard_plan.shard_plan_id,
      shard_plan_key: entry.shard_plan.shard_plan_key,
      current_binding: event.binding,
      frozen_snapshot: snapshot,
      aggregation_policy_version: "rsi.aggregate/2" as const,
      review_policy_version: "rsi.aggregate.review/1" as const,
      // A fully deterministic shard plan has no request binding to carry the
      // validator identity, so the pipeline states it explicitly. With any
      // binding present the persisted key stays authoritative and this field
      // is omitted, keeping the classic aggregation path byte-identical.
      ...(entry.bindings.length === 0
        ? { validator_binding_key: deps.evd.validator_binding_key }
        : {}),
      ...(entry.decided_question_keys.length > 0
        ? { decided_question_keys: entry.decided_question_keys }
        : {})
    };
    const aggregate = await deps.aggregator.aggregate(request);
    if (!aggregate.ok) {
      return err(aggregate.error);
    }
    let chosen = aggregate.value;

    // W4: one call per aggregate that needs evidence. A `resolved` outcome is
    // applied only on the original frozen snapshot/shard plan at the same
    // binding: the reducer re-validates every decided key against the frozen
    // hard facts, so an out-of-snapshot fact can never be smuggled in.
    const supplement = deps.evidence_supplement;
    if (
      chosen.final_state === "needs_evidence" &&
      supplement !== undefined &&
      issue !== undefined
    ) {
      const supplemented = await supplement.port.supplement(
        supplementInput({
          deps,
          event,
          issue,
          plan,
          pack: entry.pack,
          aggregate: chosen,
          options: supplement,
          signal
        })
      );
      if (!supplemented.ok) {
        return err(supplemented.error);
      }
      const outcome = supplemented.value.outcome;
      switch (outcome.status) {
        case "resolved": {
          const decidedKeys = [
            ...new Set([
              ...(request.decided_question_keys ?? []),
              ...chosen.coverage.required_question_keys
            ])
          ];
          // A resolved outcome may only be applied to the frozen snapshot it
          // was computed against. A fact that is not in that snapshot forces
          // a rebuild; trusting `fact_keys` would let a supplement smuggle in
          // evidence the aggregate never saw.
          const frozenFactKeys = new Set(
            snapshot
              .listHardFacts({
                binding: snapshot.binding,
                watermark: snapshot.watermark
              })
              .map((fact) => fact.fact_key)
          );
          const outsideSnapshot = outcome.decision.fact_keys.filter(
            (key) => !frozenFactKeys.has(key)
          );
          if (outcome.requires_repack || outsideSnapshot.length > 0) {
            // The deciding facts are not part of the original freeze, so the
            // old aggregate must never be patched in place. Reload the same
            // binding, compile a new pack/shard plan and aggregate again.
            if (supplement.rebuild === undefined) {
              note(
                `supplement:repack_required:${chosen.aggregate_id}:record=${outcome.record_id}${
                  outsideSnapshot.length > 0
                    ? `:outside_fact_keys=${outsideSnapshot.length}`
                    : ""
                }`
              );
              break;
            }
            const rebuilt = await supplement.rebuild.rebuild({
              binding: event.binding,
              issue_id: plan.issue_id,
              plan_id: plan.plan_id,
              plan_hash: plan.plan_hash as Hash,
              original_pack: entry.pack,
              original_aggregate: chosen,
              fact_keys: outcome.decision.fact_keys,
              decided_question_keys: decidedKeys,
              signal
            });
            if (!rebuilt.ok) {
              return err(rebuilt.error);
            }
            if (rebuilt.value.status === "resolved") {
              chosen = rebuilt.value.aggregate;
              note(
                `supplement:rebuilt:${chosen.aggregate_id}:record=${outcome.record_id}:pack=${rebuilt.value.pack_key}:aggregate=${rebuilt.value.aggregate_hash}`
              );
            } else {
              note(
                `supplement:repack_unresolved:${chosen.aggregate_id}:record=${outcome.record_id}:reasons=${rebuilt.value.reason_codes.join(",")}`
              );
            }
            break;
          }
          const resolved = await deps.aggregator.aggregate({
            ...request,
            decided_question_keys: decidedKeys
          });
          if (!resolved.ok) {
            return err(resolved.error);
          }
          if (!judgedBasis(resolved.value)) {
            return err(
              pipelineError({
                code: "E_CONFLICT",
                category: "conflict",
                stage: "aggregation",
                message_key: "error.conflict",
                details: { kind: "none" }
              })
            );
          }
          chosen = resolved.value;
          note(
            `supplement:resolved:${chosen.aggregate_id}:record=${outcome.record_id}:facts=${outcome.decision.fact_keys.length}:decided=${decidedKeys.length}`
          );
          break;
        }
        case "insufficient":
          note(
            `supplement:insufficient:${chosen.aggregate_id}:budget_cap=${String(outcome.budget_cap)}:gaps=${outcome.gaps.length}:record=${outcome.record_id}`
          );
          break;
        case "disabled":
          note(`supplement:disabled:${chosen.aggregate_id}`);
          break;
      }
    }

    const written = await deps.evd.writer.commitAggregate({
      binding: event.binding,
      aggregate: chosen
    });
    if (!writeResultOk(written)) {
      return err(rejected("aggregation", "online_pipeline.evd_aggregate_not_written"));
    }
    aggregates.push(chosen);
  }
  return ok({ aggregates });
}

/* ------------------------------------------------------------------ */
/* Judgment stage                                                      */
/* ------------------------------------------------------------------ */

interface JudgmentStageResult {
  readonly reasons: readonly string[];
}

function gapFor(aggregate: AnswerAggregateV2): ReadonlyArray<{
  readonly code: string;
  readonly requirement_ids: string[];
  readonly source_refs: SourceRef[];
  readonly affects_question_keys: string[];
}> {
  return aggregate.missing.map((entry) => ({
    code: entry.kind,
    requirement_ids: [],
    source_refs: entry.source_refs,
    affects_question_keys: [entry.question_key]
  }));
}

function judgedBasis(aggregate: AnswerAggregateV2): boolean {
  return (
    (aggregate.final_state === "consistent" || aggregate.final_state === "inconsistent") &&
    (aggregate.final_basis === "hard_fact" ||
      (aggregate.final_state === "consistent" && aggregate.final_basis === "mixed"))
  );
}

/**
 * Builds the W4 supplement request from data this stage already holds.
 *
 * Every view is a projection: the plan's proposition/requirement binding
 * comes from the aggregate's propositions (the reducer's own view), the pack
 * facts and requirements come from the compiled pack, and gaps are the
 * aggregate's missing entries. Nothing is re-derived or upgraded.
 */
function supplementInput(input: {
  readonly deps: OnlineDownstreamDeps;
  readonly event: CommittedHostEvent;
  readonly issue: OnlineIssue;
  readonly plan: OnlineQuestionPlan;
  readonly pack: EvidencePack;
  readonly aggregate: AnswerAggregateV2;
  readonly options: SupplementPipelineOptions;
  readonly signal?: AbortSignal;
}): EvidenceSupplementInput {
  const { aggregate, pack, issue, plan, options, event } = input;
  const snapshot = input.deps.qp.planner.deps.evidence;
  const questions = plan.questions.map((question) => {
    const proposition = aggregate.propositions.find((entry) =>
      entry.question_keys.includes(question.question_key)
    );
    return {
      question_key: question.question_key,
      ...(proposition === undefined ? {} : { proposition_id: proposition.proposition_id }),
      requirement_ids: proposition?.requirement_ids ?? [],
      required_for_issue: question.required_for_issue
    };
  });
  const gaps: SupplementGapView[] = aggregate.missing.map((entry) => ({
    code: entry.kind,
    requirement_ids: [],
    source_refs: entry.source_refs,
    affects_question_keys: [entry.question_key]
  }));
  const facts: SupplementFact[] = snapshot
    .listHardFacts({ binding: snapshot.binding, watermark: snapshot.watermark })
    .map((fact) => ({
      fact_key: fact.fact_key,
      independence_key: fact.independence_key,
      requirement_id: fact.requirement_id,
      ...(fact.proposition_id === undefined ? {} : { proposition_id: fact.proposition_id }),
      effect: fact.effect,
      verified: true,
      task_id: snapshot.binding.task_id,
      branch_id: snapshot.binding.branch_id,
      input_epoch: snapshot.binding.input_epoch,
      goal_version: snapshot.binding.goal_version,
      config_version: snapshot.binding.config_version,
      watermark: snapshot.watermark,
      stale: false,
      source_refs: fact.source_refs
    }));
  return {
    binding: event.binding,
    issue: {
      issue_id: issue.issue_id,
      issue_key: issue.issue_key,
      issue_type: issue.issue_type,
      question_text: issue.question_text,
      requirement_ids: issue.requirement_ids
    },
    plan: {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash as Hash,
      questions
    },
    pack: {
      pack_id: pack.pack_id,
      pack_key: pack.pack_key,
      pack_hash: pack.pack_hash,
      issue_id: pack.issue_id,
      issue: pack.issue,
      requirements: pack.requirements.map((requirement) => ({
        id: requirement.id,
        quote: requirement.quote,
        source_refs: requirement.source_refs,
        source_id: requirement.source_id
      })),
      facts: pack.facts.map((fact) => ({
        id: fact.id,
        source_id: fact.source_id,
        kind: fact.kind,
        excerpt: fact.excerpt,
        source_refs: fact.source_refs,
        content_hash: fact.content_hash,
        retrievable: fact.retrievable
      }))
    },
    aggregate: {
      aggregate_id: aggregate.aggregate_id,
      aggregate_hash: aggregate.aggregate_hash,
      missing: aggregate.missing.map((entry) => ({
        question_key: entry.question_key,
        kind: entry.kind,
        source_refs: entry.source_refs,
        recoverable: entry.recoverable
      })),
      hard_facts: aggregate.hard_facts.map((fact) => ({ fact_key: fact.fact_key }))
    },
    gaps,
    facts,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  };
}

async function runJudgmentStage(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  issues: readonly OnlineIssue[],
  plans: readonly OnlineQuestionPlan[],
  compiled: readonly CompiledPlan[],
  aggregates: readonly AnswerAggregateV2[]
): Promise<Result<JudgmentStageResult, ErrorEnvelope>> {
  const planner = deps.qp.planner;
  const reasons: string[] = [];

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const aggregate = aggregates[index];
    const issue = issues.find((candidate) => candidate.issue_id === plan?.issue_id);
    const entry = compiled[index];
    if (plan === undefined || aggregate === undefined || issue === undefined || entry === undefined) {
      continue;
    }

    if (judgedBasis(aggregate)) {
      const judged = await planner.recordJudgment({
        transition_id: `judgment:${aggregate.aggregate_id}`,
        issue_id: issue.issue_id,
        expected_version: issue.issue_version,
        source: {
          kind: "answer_aggregate",
          aggregate_id: aggregate.aggregate_id,
          expected_aggregate_hash: aggregate.aggregate_hash,
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash
        }
      });
      if (judged.status === "rejected") {
        return err(
          rejected("issue_judgment", `online_pipeline.record_judgment:${failureCode(judged.errors)}`)
        );
      }
      reasons.push(`judged:${aggregate.final_state}:${aggregate.final_basis}`);

      if (deps.close_evidence !== undefined) {
        const close = await deps.close_evidence.read({
          event,
          issue,
          aggregate,
          pack: entry.pack
        });
        if (!close.ok) {
          return err(close.error);
        }
        if (close.value !== null) {
          const closed = await planner.close({
            transition_id: `close:${aggregate.aggregate_id}`,
            issue_id: issue.issue_id,
            expected_version: issue.issue_version + 1,
            mode: "judgment",
            close_evidence: close.value
          });
          if (closed.status === "rejected") {
            return err(
              rejected("issue_close", `online_pipeline.close_issue:${failureCode(closed.errors)}`)
            );
          }
          reasons.push(`closed:${close.value.kind}`);
        }
      }
      continue;
    }

    if (aggregate.final_state === "needs_evidence") {
      // W4 supplementation already ran for this aggregate in the aggregation
      // stage. A resolved outcome re-aggregated under the same frozen
      // snapshot and never reaches this branch; repack-required and
      // insufficient outcomes keep the classic `needs_evidence` transition.
      const required = planner.requireEvidence({
        transition_id: `needs-evidence:${aggregate.aggregate_id}`,
        issue_id: issue.issue_id,
        expected_version: issue.issue_version,
        gaps: gapFor(aggregate),
        reason: "evidence_missing"
      });
      if (required.status === "rejected") {
        return err(
          rejected(
            "issue_judgment",
            `online_pipeline.require_evidence:${failureCode(required.errors)}`
          )
        );
      }
      reasons.push("needs_evidence");
      continue;
    }

    const abstained = planner.abstain({
      transition_id: `abstain:${aggregate.aggregate_id}`,
      issue_id: issue.issue_id,
      expected_version: issue.issue_version,
      reason: "unresolved_conflict",
      gaps: gapFor(aggregate)
    });
    if (abstained.status === "rejected") {
      return err(
        rejected("issue_judgment", `online_pipeline.abstain:${failureCode(abstained.errors)}`)
      );
    }
    reasons.push(`abstained:${aggregate.final_state}`);
  }
  return ok({ reasons });
}

/* ------------------------------------------------------------------ */
/* Decision stage                                                      */
/* ------------------------------------------------------------------ */

function decisionDraft(input: {
  readonly event: CommittedHostEvent;
  readonly issue: OnlineIssue;
  readonly aggregate: AnswerAggregateV2;
  readonly policy_version: string;
  readonly inputs: DecisionDraft["inputs"];
  readonly now: number;
}): DecisionDraft {
  const { aggregate, issue } = input;
  if (judgedBasis(aggregate)) {
    const hardFact = aggregate.final_basis === "hard_fact";
    return {
      schema_version: "rsi.decision_draft/1",
      binding: input.event.binding,
      policy_version: input.policy_version,
      issue_id: issue.issue_id,
      action: hardFact
        ? {
            kind: "fact_reminder",
            targets: [
              { kind: "issue", id: issue.issue_id },
              { kind: "pack", hash: aggregate.input_keys.pack_hash }
            ],
            requirement_ids: Array.from(
              new Set(aggregate.requirements.map((entry) => entry.requirement_id))
            ).sort(),
            fact_ids: Array.from(
              new Set(aggregate.hard_facts.map((entry) => entry.fact_key))
            ).sort()
          }
        : {
            kind: "semantic_reminder",
            targets: [
              { kind: "issue", id: issue.issue_id },
              { kind: "pack", hash: aggregate.input_keys.pack_hash }
            ],
            question_plan_id: aggregate.plan_id,
            pack_hash: aggregate.input_keys.pack_hash
          },
      outcome: "ok",
      reason_code: hardFact ? "hard_fact" : "semantic_candidate",
      dedupe_key: aggregate.aggregate_key,
      evidence_hash: aggregate.input_keys.pack_hash,
      pack_hash: aggregate.input_keys.pack_hash,
      request_hash: null,
      delivery_id: null,
      job_id: null,
      write_id: null,
      aggregate_id: aggregate.aggregate_id,
      inputs: input.inputs,
      diagnostics: {
        rule_ids: ["online_pipeline.judged"],
        classifier_version: "online-pipeline/1",
        degraded_reasons: [],
        elapsed_ms: 0
      }
    };
  }
  if (aggregate.final_state === "needs_evidence") {
    return {
      schema_version: "rsi.decision_draft/1",
      binding: input.event.binding,
      policy_version: input.policy_version,
      issue_id: issue.issue_id,
      action: {
        kind: "needs_evidence",
        targets: [{ kind: "issue", id: issue.issue_id }],
        missing: ["source"]
      },
      outcome: "ok",
      reason_code: "missing_evidence",
      dedupe_key: aggregate.aggregate_key,
      evidence_hash: aggregate.input_keys.pack_hash,
      pack_hash: aggregate.input_keys.pack_hash,
      request_hash: null,
      delivery_id: null,
      job_id: null,
      write_id: null,
      aggregate_id: aggregate.aggregate_id,
      inputs: input.inputs,
      diagnostics: {
        rule_ids: ["online_pipeline.needs_evidence"],
        classifier_version: "online-pipeline/1",
        degraded_reasons: [],
        elapsed_ms: 0
      }
    };
  }
  return {
    schema_version: "rsi.decision_draft/1",
    binding: input.event.binding,
    policy_version: input.policy_version,
    issue_id: issue.issue_id,
    action: {
      kind: "abstain",
      targets: [{ kind: "issue", id: issue.issue_id }],
      cause: aggregate.final_state === "abstain" ? "answer_conflict" : "semantic_unknown"
    },
    outcome: "ok",
    reason_code: "ambiguous",
    dedupe_key: aggregate.aggregate_key,
    evidence_hash: aggregate.input_keys.pack_hash,
    pack_hash: aggregate.input_keys.pack_hash,
    request_hash: null,
    delivery_id: null,
    job_id: null,
    write_id: null,
    aggregate_id: aggregate.aggregate_id,
    inputs: input.inputs,
    diagnostics: {
      rule_ids: ["online_pipeline.abstain"],
      classifier_version: "online-pipeline/1",
      degraded_reasons: [],
      elapsed_ms: 0
    }
  };
}

interface DecisionStageResult {
  readonly decision_ids: readonly Id<"dec">[];
}

async function runDecisionStage(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  issues: readonly OnlineIssue[],
  plans: readonly OnlineQuestionPlan[],
  aggregates: readonly AnswerAggregateV2[]
): Promise<Result<DecisionStageResult, ErrorEnvelope>> {
  const decisionIds: Id<"dec">[] = [];
  for (let index = 0; index < aggregates.length; index += 1) {
    const aggregate = aggregates[index];
    const plan = plans[index];
    const issue = issues.find((candidate) => candidate.issue_id === plan?.issue_id);
    if (aggregate === undefined || plan === undefined || issue === undefined) {
      continue;
    }
    const inputs = await deps.decision_inputs.read({
      event,
      binding: event.binding,
      issue,
      aggregate
    });
    if (!inputs.ok) {
      return err(inputs.error);
    }
    const recorded = await deps.decision.record(
      decisionDraft({
        event,
        issue,
        aggregate,
        policy_version: deps.qp.detector_version ?? DEFAULT_DETECTOR_VERSION,
        inputs: inputs.value,
        now: deps.now()
      })
    );
    if (!recorded.ok) {
      return err(recorded.error);
    }
    decisionIds.push(recorded.value.decision_id);
  }
  return ok({ decision_ids: decisionIds });
}

/* ------------------------------------------------------------------ */
/* Delivery stage                                                      */
/* ------------------------------------------------------------------ */

interface DeliveryStageResult {
  readonly delivery_ids: readonly Id<"del">[];
  readonly outbox_effect_keys: readonly string[];
}

async function runDeliveryStage(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  issues: readonly OnlineIssue[],
  plans: readonly OnlineQuestionPlan[],
  compiled: readonly CompiledPlan[],
  aggregates: readonly AnswerAggregateV2[]
): Promise<Result<DeliveryStageResult, ErrorEnvelope>> {
  const delivery = deps.delivery;
  if (delivery === undefined) {
    return ok({ delivery_ids: [], outbox_effect_keys: [] });
  }
  const deliveryIds: Id<"del">[] = [];
  const effectKeys: string[] = [];

  for (let index = 0; index < aggregates.length; index += 1) {
    const aggregate = aggregates[index];
    const plan = plans[index];
    const entry = compiled[index];
    const issue = issues.find((candidate) => candidate.issue_id === plan?.issue_id);
    if (
      aggregate === undefined ||
      plan === undefined ||
      entry === undefined ||
      issue === undefined
    ) {
      continue;
    }
    if (!judgedBasis(aggregate)) {
      continue;
    }
    const prepared = await delivery.prepare({
      event,
      issue,
      aggregate,
      pack: entry.pack
    });
    if (!prepared.ok) {
      return err(prepared.error);
    }
    const created = await delivery.create({
      plan: prepared.value.plan,
      content: prepared.value.content
    });
    if (!created.ok) {
      return err(created.error);
    }
    deliveryIds.push(created.value.delivery.delivery_id);
    if (created.value.dedupe_hit) {
      continue;
    }
    const enqueued = await delivery.enqueue(prepared.value.outbox);
    if (!enqueued.ok) {
      return err(enqueued.error);
    }
    effectKeys.push(enqueued.value);
  }
  return ok({ delivery_ids: deliveryIds, outbox_effect_keys: effectKeys });
}

/* ------------------------------------------------------------------ */
/* Downstream orchestration                                            */
/* ------------------------------------------------------------------ */

/**
 * Runs the post-QP tail: EVD compile, Jev dispatch, aggregation, judgment,
 * decision records and delivery.
 *
 * Admission and QP are inputs, not work: `input.admitted` supplies the
 * trigger identity, accumulated stages and diagnostics, while `input.qp`
 * supplies the discovered issues, plans and their lifecycle states. This is
 * the same sequence `createOnlinePipeline` runs, exposed so a default
 * composition can persist admission once and reuse the tail.
 */
export async function runOnlineDownstream(
  deps: OnlineDownstreamDeps,
  event: CommittedHostEvent,
  input: OnlineDownstreamInput,
  options?: { readonly signal?: AbortSignal }
): Promise<Result<OnlinePipelineOutcome, ErrorEnvelope>> {
  const signal = options?.signal ?? new AbortController().signal;
  const stages: OnlinePipelineStage[] = [...input.admitted.stages];
  const diagnostics: string[] = [...input.admitted.diagnostics];
  const note = (message: string): void => {
    diagnostics.push(message);
    deps.on_diagnostic?.(message);
  };

  const evd = await runEvdStage(deps, event, input.qp.plans, input.qp.plan_states, note);
  if (!evd.ok) {
    return err(evd.error);
  }
  stages.push("evidence_pack", "evidence_shard", "evidence_binding");

  const bindings = evd.value.flatMap((entry) => entry.bindings);
  // A zero-binding plan is a no-op unless the deterministic short-circuit is
  // enforcing and every plan really did settle its shards from hard facts.
  // Plans whose shards were all `budget_rejected` keep the classic no-op.
  const deterministicOnly =
    evd.value.length > 0 &&
    evd.value.every(
      (entry) => entry.bindings.length === 0 && entry.skipped_shard_keys.length > 0
    );
  const proceedWithoutDispatch =
    deps.dispatch?.mode === "enforce" && deterministicOnly;
  if (bindings.length === 0 && !proceedWithoutDispatch) {
    note("evd.no_dispatchable_shard");
    return ok({
      status: "no_op",
      stages,
      decision: input.admitted.decision,
      trigger_event_id: input.admitted.trigger_event_id,
      review_job_id: input.admitted.review_job_id,
      issues: [],
      plans: [],
      packs: [],
      shard_plans: [],
      bindings: [],
      envelopes: [],
      aggregates: [],
      decision_ids: [],
      delivery_ids: [],
      outbox_effect_keys: [],
      diagnostics
    });
  }

  let envelopes: readonly JudgeEnvelopeV3[] = [];
  if (bindings.length > 0) {
    const jev = await runJevStage(deps, bindings, signal);
    if (!jev.ok) {
      return err(jev.error);
    }
    envelopes = jev.value.envelopes;
    stages.push("jev_dispatch");
  } else {
    note("jev.skipped_no_semantic_question");
  }

  const aggregated = await runAggregateStage(
    deps,
    event,
    input.qp.issues,
    input.qp.plans,
    evd.value,
    note,
    signal
  );
  if (!aggregated.ok) {
    return err(aggregated.error);
  }
  stages.push("aggregation");

  const judged = await runJudgmentStage(
    deps,
    event,
    input.qp.issues,
    input.qp.plans,
    evd.value,
    aggregated.value.aggregates
  );
  if (!judged.ok) {
    return err(judged.error);
  }
  stages.push("issue_judgment");
  if (judged.value.reasons.some((reason) => reason.startsWith("closed:"))) {
    stages.push("issue_close");
  }

  const decisions = await runDecisionStage(
    deps,
    event,
    input.qp.issues,
    input.qp.plans,
    aggregated.value.aggregates
  );
  if (!decisions.ok) {
    return err(decisions.error);
  }
  stages.push("decision_record");

  const delivery = await runDeliveryStage(
    deps,
    event,
    input.qp.issues,
    input.qp.plans,
    evd.value,
    aggregated.value.aggregates
  );
  if (!delivery.ok) {
    return err(delivery.error);
  }
  if (delivery.value.delivery_ids.length > 0) {
    stages.push("delivery");
  }

  return ok({
    status: "completed",
    stages,
    decision: input.admitted.decision,
    trigger_event_id: input.admitted.trigger_event_id,
    review_job_id: input.admitted.review_job_id,
    issues: input.qp.issues,
    plans: input.qp.plans,
    packs: evd.value.map((entry) => entry.pack),
    shard_plans: evd.value.map((entry) => entry.shard_plan),
    bindings,
    envelopes,
    aggregates: aggregated.value.aggregates,
    decision_ids: decisions.value.decision_ids,
    delivery_ids: delivery.value.delivery_ids,
    outbox_effect_keys: delivery.value.outbox_effect_keys,
    diagnostics
  });
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds the online pipeline over injected HOST, QP, EVD and delivery seams.
 * The returned pipeline is pure with respect to construction: all writes go
 * through the injected ports and component writers.
 */
export function createOnlinePipeline(deps: OnlinePipelineDeps): OnlinePipeline {
  return {
    async run(event, options) {
      const signal = options?.signal ?? new AbortController().signal;
      const stages: OnlinePipelineStage[] = ["event_commit"];
      const diagnostics: string[] = [];
      const note = (message: string): void => {
        diagnostics.push(message);
        deps.on_diagnostic?.(message);
      };

      const trigger = await runTriggerStage(deps, event);
      if (!trigger.ok) {
        return err(trigger.error);
      }
      stages.push("trigger_policy");
      if (trigger.value.kind === "deferred") {
        stages.push("trigger_admission");
        return ok(outcome("deferred", stages, trigger.value, diagnostics));
      }
      if (trigger.value.kind === "no_op") {
        stages.push("trigger_admission");
        return ok(outcome("no_op", stages, trigger.value, diagnostics));
      }
      stages.push("trigger_admission");
      if (deps.progress !== undefined) {
        stages.push("progress_checkpoint");
      }

      const qp = await runQpStage(deps, event);
      if (!qp.ok) {
        return err(qp.error);
      }
      stages.push("issue_discovery");
      if (qp.value.plans.length === 0) {
        note(`qp.no_op:${qp.value.no_op_reason ?? "no_issue"}`);
        return ok(outcome("no_op", stages, trigger.value, diagnostics));
      }
      stages.push("issue_plan");

      const downstream = await runOnlineDownstream(
        deps,
        event,
        {
          admitted: outcome("completed", stages, trigger.value, diagnostics),
          qp: {
            issues: qp.value.issues,
            plans: qp.value.plans,
            plan_states: qp.value.plan_states
          }
        },
        { signal }
      );
      if (!downstream.ok) {
        return err(downstream.error);
      }
      return ok(downstream.value);
    }
  };
}

function outcome(
  status: "completed" | "no_op" | "deferred",
  stages: readonly OnlinePipelineStage[],
  trigger: TriggerStageResult,
  diagnostics: readonly string[]
): OnlinePipelineOutcome {
  return {
    status,
    stages,
    decision: trigger.decision,
    trigger_event_id: trigger.trigger_event_id,
    review_job_id: trigger.review_job_id,
    issues: [],
    plans: [],
    packs: [],
    shard_plans: [],
    bindings: [],
    envelopes: [],
    aggregates: [],
    decision_ids: [],
    delivery_ids: [],
    outbox_effect_keys: [],
    diagnostics
  };
}

/* ------------------------------------------------------------------ */
/* event.ingest post-commit hook                                       */
/* ------------------------------------------------------------------ */

/**
 * Adapts the pipeline to the `event.ingest` post-commit hook. The ACK has
 * already been produced; a pipeline failure is reported only through
 * `on_error` and never turns the committed event into a rejection.
 */
export function createPostCommitHook(
  pipeline: OnlinePipeline,
  on_error?: (error: ErrorEnvelope) => void
): (event: CommittedHostEvent) => void {
  return (event: CommittedHostEvent): void => {
    void pipeline.run(event).then(
      (result) => {
        if (!result.ok && on_error !== undefined) {
          on_error(result.error);
        }
      },
      (error: unknown) => {
        if (on_error !== undefined) {
          on_error(
            pipelineError({
              code: "E_INTERNAL",
              category: "internal",
              stage: "event_commit",
              message_key: "error.internal.unexpected",
              details: {
                kind: "internal",
                incident_id: `online_pipeline.post_commit:${String(error)}`
              }
            })
          );
        }
      }
    );
  };
}

/** Convenience for callers that already have the receipt and draft. */
export function committedEvent(
  receipt: IngestReceipt,
  draft: EventDraft
): CommittedHostEvent {
  return { receipt, draft, binding: bindingFromReceipt(receipt) };
}
