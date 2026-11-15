/**
 * REV composition for the kernel (DD-REV-140, DD-REV-151, DD-REV-170).
 *
 * The kernel owns the single SQLite connection and the journal writer. This
 * module supplies the REV repository/write ports over that connection and
 * wires the scheduler, review service, worker and Experience service without
 * importing a host adapter. Capabilities the process does not own fail closed:
 * absent generation/egress/verifier ports never synthesize success.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  canonicalHash,
  canonicalJson,
  canonicalJsonText,
  hashBytes,
  makeErrorEnvelope,
  newId,
  ok,
  parseSourceRef,
  toJsonValue
} from "@evoplug/core";
import type {
  Clock,
  ConfigVersionReadPort,
  ConfigVersionView,
  CurrentGoalView,
  ErrorEnvelope,
  GoalVersionReadPort,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  Tx,
  VersionBinding
} from "@evoplug/core";
import {
  BlobStore,
  JournalWriter,
  createJournalCommitter,
  createTransactionRunner,
  listJournalStates,
  orderStateRowBatchMembers,
  stateRowBatchHash,
  stateRowBatchMemberHash
} from "@evoplug/storage";
import type { JournalCommitter, JournalFramePayload, SqliteConnection } from "@evoplug/storage";

import {
  DefaultExperienceService,
  DefaultReviewService,
  ReviewWorker,
  acceptanceRowFromParts,
  adoptionBindingHash,
  backendSelectionRef,
  blobRef,
  buildAdoptionBinding,
  buildLifecycleEvent,
  buildReviewJob,
  buildReviewSnapshot,
  candidateKeyFrom,
  computeReviewScopeKey,
  computeBoundaryKey,
  computeSignalDigest,
  computeTriggerDedupeKey,
  createInitialProjection,
  applyProjection,
  dispatchMatchJudge,
  mapQpResult,
  createReviewHandoffReadPort,
  defaultReviewOutputPolicySource,
  deriveExperienceScope,
  disabledProjection,
  enqueueInTransactionSync,
  experienceBodyBytes,
  experienceRowFromExperience,
  experienceMatchTemplateHash,
  generatorInputManifestHash,
  jobRowFromJob,
  markJobDone,
  nextSequence,
  normalizeRisk,
  parseGeneratorOutput,
  prepareReviewEnqueue,
  proposalHash,
  projectionFromRow,
  projectionRowFromProjection,
  proposalRowFromProposal,
  reviewQuotaPolicyHash,
  reviewSnapshotSourcePlanHash,
  snapshotRowFromSnapshot,
  attemptRowFromAttempt,
  candidateRowFromRecord,
  handoffRowFromHandoff,
  lifecycleEventRowFromEvent,
  usageRowFromRecord,
  validateAdoptionView,
  validationPlanRowFromPlan
} from "@evoplug/review";
import type {
  AcceptanceCommitInput,
  ClaimedAttempt,
  EgressApprovedSourcesInput,
  EgressApprovedSourcesView,
  EgressDecisionPort,
  EvidenceInput,
  ExperienceCommitPort,
  ExperienceProjection,
  ExperienceReviewPlanningInput,
  ExperienceService,
  ExperienceServiceDeps,
  GeneratorInput,
  GeneratorRunnerPort,
  HandoffCommitInput,
  HostEventBinding,
  HostGenerationPort,
  JevServiceProfile,
  JudgeCommitInput,
  JudgeDispatchInput,
  JudgeService,
  JudgeRunBudget,
  LiveCommitStage,
  PreparedReviewEnqueue,
  Proposal,
  ProposalCandidate,
  ProposalCandidateRecord,
  QuestionPlanner,
  ResolvedTarget,
  ReviewAttempt,
  ReviewEnqueueRequest,
  ReviewEnqueueResult,
  ReviewHandoff,
  ReviewHandoffReadPort,
  ReviewJob,
  ReviewRepository,
  ReviewScheduler,
  ReviewService,
  ReviewServiceDeps,
  ReviewSnapshot,
  ReviewWritePort,
  RevError,
  RevResult,
  StaticCheckCommitInput,
  StaticCheckContext,
  StageStateRow,
  TriggerEvent,
  UsageVerificationRecord,
  ValidationPlan,
  Experience,
  ExperienceLifecycleEvent
} from "@evoplug/review";

import {
  budgetError,
  budgetPolicyContentHash,
  consumeToken,
  createReservation,
  findScopePolicy,
  makeClaimCharge,
  makeOverageCharge,
  makeUsageCharge,
  parseBudgetPolicy,
  planClaim,
  planReservation,
  planSettlement,
  readReservationInTransaction,
  validateProviderUsage
} from "@evoplug/budget";
import type {
  AllowanceCharge,
  BudgetClaimRequest,
  BudgetPolicy,
  BudgetReservation,
  BudgetSettleRequest,
  ProviderUsage
} from "@evoplug/budget";

import { computeConfigVersion } from "./config.js";
import type { EvoplugConfig } from "./config.js";
import { homeLayout } from "./home.js";
import type { HomeLayout } from "./home.js";
import { createReviewExperiencePorts } from "./review-experience-ports.js";
import type {
  ExperienceRootResolver,
  ReviewExperienceRollbackExecutor
} from "./review-experience-ports.js";
import { listInstalledTriggerPolicies } from "./trigger-policy-store.js";
import {
  applyManagedBlockEdit,
  createWriteAdoptionReadPort,
  parseManagedBlocks
} from "@evoplug/auth";
import { policyRefOf, resolveTriggerPolicy } from "@evoplug/core/host";
import type {
  CapabilityBinding,
  HostGenerationAdapterPort,
  TriggerPolicyRef
} from "@evoplug/core/host";
import { createHostGenerationPort, createHostServiceProfileReadPort } from "./host-service-profile.js";
import { createSourceRefPort } from "./source-ref-port.js";
import { createSqliteExperienceCandidatePort } from "./experience-candidate-read.js";

/**
 * Canonical candidate port and the projection-creation invariant. Both are
 * re-exported here because this module is already part of the kernel's public
 * surface; no new index entry is needed.
 */
export {
  assertExperienceProjectionCreationEvents,
  createSqliteExperienceCandidatePort
} from "./experience-candidate-read.js";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function revErrFromEnvelope(error: ErrorEnvelope, cause?: string): RevError {
  const result: RevError = {
    code: error.code,
    retryable: error.retryable,
    stage: error.stage
  };
  if (error.detail_ref !== undefined) result.detail_ref = error.detail_ref;
  if (cause !== undefined) result.cause = cause;
  return result;
}

function revErr<T>(error: RevError): RevResult<T> {
  return { ok: false, error };
}

/** Public alias so the app-kernel bridge does not import `@evoplug/review`. */
export type ReviewServiceError = RevError;

function revOk<T>(value: T): RevResult<T> {
  return { ok: true, value };
}

function revError(code: string, stage: string, cause?: string): RevError {
  return cause === undefined
    ? { code, retryable: false, stage }
    : { code, retryable: false, stage, cause };
}

function unavailable(stage: string, cause: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "internal", incident_id: cause }
  });
}

function storageUnavailable(operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STORAGE_UNAVAILABLE",
    category: "storage",
    message_key: "error.storage_unavailable",
    stage: "storage",
    retryable: true,
    side_effect: "none",
    details: { kind: "storage", operation }
  });
}

/**
 * Fail-closed planner/judge defaults. Neither port is consulted by
 * `DefaultReviewService` today; they are inert until a caller injects a real
 * dispatcher that closes over them. They never fabricate a plan, route,
 * probability or verdict.
 */
const failClosedPlanner: QuestionPlanner = {
  async planExperienceReview() {
    return {
      ok: false,
      status: "rejected",
      error: unavailable("planner", "kernel.review_planner_unavailable")
    };
  }
};

const failClosedJudge: JudgeService = {
  async judgeExperienceMatch() {
    return {
      ok: false,
      status: "rejected",
      error: unavailable("judge", "kernel.review_judge_unavailable")
    };
  }
};

/**
 * Historical match-judge dispatcher: every pending proposal becomes
 * `degraded` with no route. Kept as the default so the flag-off behaviour is
 * byte-for-byte unchanged; a real dispatcher must be injected explicitly.
 */
const degradedJudgeDispatch: ReviewServiceDeps["judgeDispatch"] = {
  async dispatch({ proposal }) {
    if (proposal.match_judge.status !== "pending") {
      return ok(proposal);
    }
    return ok({
      ...proposal,
      match_judge: {
        status: "degraded",
        route_id: null,
        route_hash: null,
        route_class: null,
        template_id: "qt.experience_match",
        template_version: "1.0.0",
        template_hash: proposal.match_judge.template_hash
      }
    });
  }
};

/* ------------------------------------------------------------------ */
/* Typed QP/EVD judge injection                                       */
/* ------------------------------------------------------------------ */

/**
 * Everything the typed judge pipeline needs for one dispatch, resolved by the
 * caller from its real ports. The kernel never derives an egress decision, a
 * service profile, an endpoint, a model id, a budget or evidence content.
 *
 * `planning` is the QP input. `judge_dispatch` is the EVD input minus the
 * `plan`/`route` pair that the planner produces at dispatch time.
 */
export interface PlannerJudgeDispatchPreparation {
  readonly planning: ExperienceReviewPlanningInput;
  readonly judge_dispatch: Omit<JudgeDispatchInput, "plan" | "route">;
}

export type PlannerJudgePrepare = (input: {
  readonly job: ReviewJob;
  readonly snapshot: ReviewSnapshot;
  readonly proposal: Proposal;
  readonly now: number;
}) => Promise<Result<PlannerJudgeDispatchPreparation, ErrorEnvelope>>;

export interface PlannerJudgeDispatchOptions {
  readonly planner: QuestionPlanner;
  readonly judge: JudgeService;
  readonly prepare: PlannerJudgePrepare;
}

function degradeProposal(proposal: Proposal, _reason: string): Proposal {
  /* `ProposalMatchJudge` has no `degrade_reason` field; the reason belongs to
   * the `MatchJudgeProjection` surfaced by `runMatchJudge`. The Proposal stays
   * a pure record, with every route/plan field cleared. */
  return {
    ...proposal,
    match_judge: {
      ...proposal.match_judge,
      status: "degraded",
      route_id: null,
      route_hash: null,
      route_class: null,
      template_id: "qt.experience_match",
      template_version: "1.0.0",
      template_hash: proposal.match_judge.template_hash
    }
  };
}

/**
 * Builds the production match-judge dispatcher from a real `QuestionPlanner`
 * and a real `JudgeService` (the typed Jev client). The QP result is mapped by
 * the shared policy table, then the shared `dispatchMatchJudge` performs the
 * service-profile, template, egress and evidence gates before the judge is
 * invoked. A missing or rejected planner degrades the Proposal; no route,
 * plan, probability or verdict is synthesized here.
 *
 * The returned dispatcher is what `DefaultReviewService.runMatchJudge` calls.
 * It is the only way an injected `planner`/`judge` becomes live.
 */
export function createPlannerJudgeDispatch(
  options: PlannerJudgeDispatchOptions
): ReviewServiceDeps["judgeDispatch"] {
  return {
    async dispatch({ job, snapshot, proposal, now }) {
      if (proposal.match_judge.status !== "pending") {
        return ok(proposal);
      }
      let prepared: Result<PlannerJudgeDispatchPreparation, ErrorEnvelope>;
      try {
        prepared = await options.prepare({ job, snapshot, proposal, now });
      } catch {
        return ok(degradeProposal(proposal, "qp_prepare_unavailable"));
      }
      if (!prepared.ok) {
        return ok(degradeProposal(proposal, prepared.error.code));
      }
      let planned: Awaited<ReturnType<QuestionPlanner["planExperienceReview"]>>;
      try {
        planned = await options.planner.planExperienceReview(prepared.value.planning);
      } catch {
        return ok(degradeProposal(proposal, "qp_unavailable"));
      }
      const mapping = mapQpResult(planned);
      if (mapping.route === null || mapping.plan === null) {
        return ok({
          ...proposal,
          question_key: mapping.projection.question_key,
          match_judge: applyProjection(proposal.match_judge, mapping.projection)
        });
      }
      const judged = await dispatchMatchJudge({
        ...prepared.value.judge_dispatch,
        plan: mapping.plan,
        route: mapping.route,
        proposal,
        judge: options.judge
      });
      if (!judged.ok) {
        return judged;
      }
      return ok({
        ...proposal,
        question_key: mapping.projection.question_key,
        match_judge: judged.value
      });
    }
  };
}

/**
 * Explicit, experimental forced-pass policy.
 *
 * This is NOT a Jev verdict. It exists only for the named experiment and marks
 * every produced proposal with `validator_version`/`service_profile_id`
 * prefixed `forced_pass_experimental:<experiment_id>`. It is never enabled by
 * default, never runs the planner or judge, and never writes an Experience
 * body; adoption still requires the ordinary grant and FND write path.
 */
export interface ForcedPassExperimentPolicy {
  readonly kind: "forced_pass_experimental";
  readonly experiment_id: string;
  readonly approved_by: string;
  readonly reason: string;
}

function requireExperimentText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`forced_pass_experimental requires a non-empty ${field}`);
  }
  return value.trim();
}

export function createForcedPassExperimentDispatch(
  policy: ForcedPassExperimentPolicy
): ReviewServiceDeps["judgeDispatch"] {
  if (policy.kind !== "forced_pass_experimental") {
    throw new Error("forced pass policy kind must be forced_pass_experimental");
  }
  const experimentId = requireExperimentText(policy.experiment_id, "experiment_id");
  requireExperimentText(policy.approved_by, "approved_by");
  requireExperimentText(policy.reason, "reason");
  const label = `forced_pass_experimental:${experimentId}`;
  return {
    async dispatch({ proposal }) {
      if (proposal.match_judge.status !== "pending") {
        return ok(proposal);
      }
      const planId = `plan:${label}:${proposal.proposal_id}`;
      const questionKey = proposal.question_key ?? `forced.${experimentId}`;
      return ok({
        ...proposal,
        question_key: questionKey,
        match_judge: {
          status: "accepted",
          route_id: `route:${label}:${proposal.proposal_id}`,
          route_hash: canonicalHash(
            toJsonValue({
              kind: "forced_pass_experimental",
              experiment_id: experimentId,
              proposal_id: proposal.proposal_id,
              proposal_hash: proposal.proposal_hash,
              candidate_hash: proposal.candidate_hash
            })
          ),
          route_class: "experience_match",
          issue_id: `issue:${label}`,
          plan_id: planId,
          plan_hash: canonicalHash(
            toJsonValue({
              kind: "forced_pass_experimental_plan",
              experiment_id: experimentId,
              plan_id: planId,
              proposal_hash: proposal.proposal_hash
            })
          ),
          invocation_id: `invocation:${label}:${proposal.proposal_id}`,
          service_profile_id: `service_profile:${label}`,
          validator_binding_id: `validator:${label}`,
          validator_version: label,
          template_id: "qt.experience_match",
          template_version: "1.0.0",
          template_hash: proposal.match_judge.template_hash,
          match_outcome: "applicable"
        }
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* SQLite helpers                                                      */
/* ------------------------------------------------------------------ */

type SqlValue = string | number | null;
type SqlRow = Record<string, unknown>;

function one<T>(connection: SqliteConnection, sql: string, params?: Readonly<Record<string, SqlValue>>): T | null {
  const row = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row as T;
}

function all<T>(connection: SqliteConnection, sql: string, params?: Readonly<Record<string, SqlValue>>): T[] {
  return connection.prepare<SqlRow>(sql).all(params) as T[];
}

function tableExists(connection: SqliteConnection, table: string): boolean {
  try {
    const row = connection
      .prepare<SqlRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name")
      .get({ name: table });
    return row !== undefined;
  } catch {
    return false;
  }
}

function jsonColumn<T>(value: unknown): T | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : "{}";
}

function numberField(row: SqlRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function stringField(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function boolField(row: SqlRow, key: string): boolean {
  return numberField(row, key) === 1;
}

function toJsonObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toJsonValue(entry);
  }
  return out;
}

function sqlValue(value: JsonValue | undefined): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return canonicalJsonText(value);
}

/* ------------------------------------------------------------------ */
/* Row -> logical record                                               */
/* ------------------------------------------------------------------ */

function jobFromRow(row: SqlRow): ReviewJob {
  const job: ReviewJob = {
    schema_version: "rsi.review_job/2",
    job_id: stringField(row, "job_id") as Id<"job">,
    request_id: stringField(row, "request_id"),
    task_id: stringField(row, "task_id") as Id<"task">,
    branch_id: stringField(row, "branch_id") as Id<"br">,
    snapshot_id: stringField(row, "snapshot_id") as Id<"snap">,
    snapshot_hash: stringField(row, "snapshot_hash") as Hash,
    trigger_event_id: stringField(row, "trigger_event_id") as Id<"trg">,
    trigger_kind: stringField(row, "trigger_kind") as ReviewJob["trigger_kind"],
    review_kind: stringField(row, "review_kind") as ReviewJob["review_kind"],
    review_scope_key: stringField(row, "review_scope_key") as Hash,
    boundary_key: stringField(row, "boundary_key") as Hash,
    trigger_dedupe_key: stringField(row, "trigger_dedupe_key") as Hash,
    signal_digest: stringField(row, "signal_digest") as Hash,
    stable_event_ids: jsonColumn<string[]>(row["stable_event_ids_json"]) ?? [],
    stable_watermark: numberField(row, "stable_watermark"),
    stable: boolField(row, "stable"),
    stable_evidence_ref: stringField(row, "stable_evidence_ref") as SourceRef,
    pending_state: stringField(row, "pending_state") as ReviewJob["pending_state"],
    pending_work_refs: jsonColumn<ReviewJob["pending_work_refs"]>(row["pending_work_refs_json"]) ?? [],
    scope: jsonColumn<ReviewJob["scope"]>(row["scope_json"]) ?? {
      task_id: stringField(row, "task_id"),
      branch_id: stringField(row, "branch_id"),
      input_epoch: numberField(row, "input_epoch"),
      goal_version: stringField(row, "goal_version"),
      config_version: stringField(row, "config_version")
    },
    origin: jsonColumn<ReviewJob["origin"]>(row["origin_json"]) ?? {
      kind: "unknown",
      evidence_kind: "none",
      suppress_automatic: true
    },
    policy_ref: jsonColumn<ReviewJob["policy_ref"]>(row["policy_ref"]) ?? {
      policy_id: "pol:00000000000000000000000000" as Id<"pol">,
      policy_version: stringField(row, "policy_version"),
      policy_hash: stringField(row, "policy_hash") as Hash,
      scope_key: stringField(row, "policy_hash") as Hash
    },
    policy_version: stringField(row, "policy_version"),
    policy_hash: stringField(row, "policy_hash") as Hash,
    capability_snapshot_hash: stringField(row, "capability_snapshot_hash") as Hash,
    budget_policy_ref: stringField(row, "budget_policy_ref"),
    budget_policy_hash: stringField(row, "budget_policy_hash") as Hash,
    input_epoch: numberField(row, "input_epoch"),
    goal_version: stringField(row, "goal_version"),
    config_version: stringField(row, "config_version"),
    state: stringField(row, "state") as ReviewJob["state"],
    stage: stringField(row, "stage") as ReviewJob["stage"],
    backend: jsonColumn<ReviewJob["backend"]>(row["backend_json"]) ?? {
      missing_capabilities: [],
      cancellation: "blocked",
      recovery: "blocked"
    },
    current_fencing_token: numberField(row, "current_fencing_token"),
    attempt_count: numberField(row, "attempt_count"),
    proposal_ids: jsonColumn<ReviewJob["proposal_ids"]>(row["proposal_ids_json"]) ?? [],
    supersession_depth: numberField(row, "supersession_depth"),
    allowance_charge: jsonColumn<ReviewJob["allowance_charge"]>(row["allowance_charge_json"]) ?? {
      reservation_ids: [],
      charge_ids: [],
      attempts: 0,
      input_tokens_charged: null,
      output_tokens_charged: null,
      cost_micros_charged: null,
      unknown_usage: false,
      overage: false
    },
    provider_usage: jsonColumn<ReviewJob["provider_usage"]>(row["provider_usage_json"]) ?? {
      usage_refs: [],
      reported_attempts: 0,
      input_tokens: null,
      output_tokens: null,
      cost_micros: null,
      cost_status: "not_applicable",
      sources: []
    },
    version: numberField(row, "version"),
    created_at: numberField(row, "created_at"),
    updated_at: numberField(row, "updated_at")
  };
  const blockReason = nullableString(row, "block_reason");
  if (blockReason !== null) job.block_reason = blockReason as NonNullable<ReviewJob["block_reason"]>;
  const activeAttempt = nullableString(row, "active_attempt_id");
  if (activeAttempt !== null) job.active_attempt_id = activeAttempt as Id<"rat">;
  const handoffId = nullableString(row, "handoff_id");
  if (handoffId !== null) job.handoff_id = handoffId as Id<"hand">;
  const handoffRef = nullableString(row, "handoff_body_ref");
  if (handoffRef !== null) job.handoff_body_ref = handoffRef as SourceRef;
  const authorizationRef = nullableString(row, "authorization_ref");
  if (authorizationRef !== null) job.authorization_ref = authorizationRef as Id<"grant">;
  const supersedes = nullableString(row, "supersedes_job_id");
  if (supersedes !== null) job.supersedes_job_id = supersedes as Id<"job">;
  const supersededBy = nullableString(row, "superseded_by_job_id");
  if (supersededBy !== null) job.superseded_by_job_id = supersededBy as Id<"job">;
  const lastError = jsonColumn<NonNullable<ReviewJob["last_error"]>>(row["last_error_json"]);
  if (lastError !== null) job.last_error = lastError;
  const retryAfter = nullableNumber(row, "retry_after_at");
  if (retryAfter !== null) job.retry_after_at = retryAfter;
  const terminalReason = nullableString(row, "terminal_reason");
  if (terminalReason !== null) job.terminal_reason = terminalReason;
  const terminalAt = nullableNumber(row, "terminal_at");
  if (terminalAt !== null) job.terminal_at = terminalAt;
  return job;
}

function attemptFromRow(row: SqlRow): ReviewAttempt {
  const attempt: ReviewAttempt = {
    schema_version: "rsi.review_attempt/1",
    attempt_id: stringField(row, "attempt_id") as Id<"rat">,
    attempt_key: stringField(row, "attempt_key") as Hash,
    job_id: stringField(row, "job_id") as Id<"job">,
    ordinal: numberField(row, "ordinal"),
    state: stringField(row, "state") as ReviewAttempt["state"],
    backend: jsonColumn<ReviewAttempt["backend"]>(row["backend_json"]) ?? {
      schema_version: "rsi.generation_backend_ref/1",
      backend_id: "",
      backend_kind: "cli",
      entry_kind: "cli_spawn",
      entry_ref: "",
      backend_version: "",
      protocol_versions: [],
      isolation: { mode: "unknown", network: "unknown", evidence_refs: [] },
      capabilities: {
        create: { status: "unknown", evidence_stage: "none", evidence_refs: [] },
        auth: { status: "unknown", evidence_stage: "none", evidence_refs: [] },
        cancel: { status: "unknown", evidence_stage: "none", evidence_refs: [] },
        recover: { status: "unknown", evidence_stage: "none", evidence_refs: [] },
        output: { status: "unknown", evidence_stage: "none", evidence_refs: [] }
      },
      capability_snapshot_hash: "" as Hash,
      approval_ref: ""
    },
    model_id: stringField(row, "model_id"),
    protocol_version: "rsi.generator_protocol/1",
    host_run: jsonColumn<ReviewAttempt["host_run"]>(row["host_run_json"]) ?? {
      generation_run_id: "",
      backend_selection_ref: stringField(row, "input_manifest_ref") as SourceRef
    },
    isolation: jsonColumn<ReviewAttempt["isolation"]>(row["isolation_json"]) ?? {
      workspace_ref: "",
      workspace_mode: "none",
      workspace_probe_ref: stringField(row, "input_manifest_ref") as SourceRef,
      environment_hash: stringField(row, "input_manifest_hash") as Hash,
      network_decision_ref: stringField(row, "input_manifest_ref") as SourceRef,
      isolation_evidence_ref: stringField(row, "input_manifest_ref") as SourceRef
    },
    input_manifest_ref: stringField(row, "input_manifest_ref") as SourceRef,
    input_manifest_hash: stringField(row, "input_manifest_hash") as Hash,
    output_ref: stringField(row, "output_ref") as SourceRef,
    budget: jsonColumn<ReviewAttempt["budget"]>(row["budget_json"]) ?? {
      state: "unclaimed",
      input_tokens_estimated: 0,
      output_tokens_reserved: 0,
      wall_ms_reserved: 0
    },
    cancel: jsonColumn<ReviewAttempt["cancel"]>(row["cancel_json"]) ?? {},
    allowance_charge: jsonColumn<ReviewAttempt["allowance_charge"]>(row["allowance_charge_json"]) ?? {
      charge_ids: [],
      input_token_charges: null,
      output_token_charges: null,
      cost_charges_micros: null,
      overage: false
    },
    provider_usage: jsonColumn<ReviewAttempt["provider_usage"]>(row["provider_usage_json"]) ?? {
      usage_refs: [],
      input_tokens: null,
      output_tokens: null,
      cost_micros: null,
      cost_status: "not_applicable",
      source: "none"
    },
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    updated_at: numberField(row, "updated_at")
  };
  const outputHash = nullableString(row, "output_hash");
  if (outputHash !== null) {
    attempt.output = {
      ref: attempt.output_ref,
      hash: outputHash as Hash,
      bytes: 0,
      lines: 0,
      proposal_count: 0,
      schema_valid: "unknown",
      accepted_at: numberField(row, "updated_at")
    };
  }
  const deadline = nullableNumber(row, "deadline_at");
  if (deadline !== null) attempt.deadline_at = deadline;
  const lease = jsonColumn<NonNullable<ReviewAttempt["lease"]>>(row["lease_json"]);
  if (lease !== null) attempt.lease = lease;
  const output = jsonColumn<NonNullable<ReviewAttempt["output"]>>(row["output_json"]);
  if (output !== null) attempt.output = output;
  const completion = nullableString(row, "completion_evidence_ref");
  if (completion !== null) attempt.completion_evidence_ref = completion as SourceRef;
  const generatorUsage = jsonColumn<NonNullable<ReviewAttempt["generator_reported_usage"]>>(row["generator_reported_usage_json"]);
  if (generatorUsage !== null) attempt.generator_reported_usage = generatorUsage;
  const exit = jsonColumn<NonNullable<ReviewAttempt["exit"]>>(row["exit_json"]);
  if (exit !== null) attempt.exit = exit;
  const lastError = jsonColumn<NonNullable<ReviewAttempt["last_error"]>>(row["last_error_json"]);
  if (lastError !== null) attempt.last_error = lastError;
  const started = nullableNumber(row, "started_at");
  if (started !== null) attempt.started_at = started;
  const ended = nullableNumber(row, "ended_at");
  if (ended !== null) attempt.ended_at = ended;
  return attempt;
}

function candidateFromRow(row: SqlRow): ProposalCandidateRecord {
  const record: ProposalCandidateRecord = {
    schema_version: "rsi.proposal_candidate_record/1",
    candidate_key: stringField(row, "candidate_key") as Hash,
    job_id: stringField(row, "job_id") as Id<"job">,
    attempt_id: stringField(row, "attempt_id") as Id<"rat">,
    ordinal: numberField(row, "ordinal"),
    version_binding: jsonColumn<VersionBinding>(row["version_binding_json"]) ?? {
      task_id: "" as Id<"task">,
      branch_id: "" as Id<"br">,
      input_epoch: 0,
      goal_version: "",
      config_version: "",
      watermark: 0
    },
    output_ref: stringField(row, "output_ref") as SourceRef,
    output_hash: stringField(row, "output_hash") as Hash,
    candidate_ref: stringField(row, "candidate_ref") as SourceRef,
    candidate_json_hash: stringField(row, "candidate_json_hash") as Hash,
    generator: jsonColumn<ProposalCandidateRecord["generator"]>(row["generator_json"]) ?? {
      backend_id: "",
      model_id: "",
      protocol_version: "rsi.generator_protocol/1",
      generator_version: ""
    },
    state: stringField(row, "state") as ProposalCandidateRecord["state"],
    failure: null,
    proposal_id: nullableString(row, "proposal_id") as Id<"prop"> | null,
    proposal_hash: nullableString(row, "proposal_hash") as Hash | null,
    experience_id: nullableString(row, "experience_id") as Id<"exp"> | null,
    experience_version: nullableNumber(row, "experience_version"),
    accepted_bundle_ref: nullableString(row, "accepted_bundle_ref") as SourceRef | null,
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    checked_at: nullableNumber(row, "checked_at")
  };
  const failureCode = nullableString(row, "failure_code");
  const failureStep = nullableString(row, "failure_step");
  const diagnostic = nullableString(row, "diagnostic_ref");
  if (failureCode !== null && failureStep !== null && diagnostic !== null) {
    record.failure = {
      code: failureCode as NonNullable<ProposalCandidateRecord["failure"]>["code"],
      step: failureStep as NonNullable<ProposalCandidateRecord["failure"]>["step"],
      detail_ref: diagnostic as SourceRef
    };
  }
  return record;
}

function proposalFromRow(row: SqlRow): Proposal {
  const proposal: Proposal = {
    schema_version: "rsi.proposal/2",
    proposal_id: stringField(row, "proposal_id"),
    proposal_hash: stringField(row, "proposal_hash") as Hash,
    job_id: stringField(row, "job_id"),
    attempt_id: stringField(row, "attempt_id"),
    ordinal: numberField(row, "ordinal"),
    question_key: nullableString(row, "question_key"),
    state: stringField(row, "state") as Proposal["state"],
    change_kind: stringField(row, "change_kind") as Proposal["change_kind"],
    target: jsonColumn<Proposal["target"]>(row["target_json"]) ?? {
      target_ref: "",
      object_type: "skill",
      host_id: "claude-code",
      config_space: "",
      mode: "exec",
      path_or_block: "",
      ownership: "rsi_managed",
      write_mode: "whole_file",
      block_selector: null,
      approved_root: "",
      target_binding_ref: "blob://sha256:0000000000000000000000000000000000000000000000000000000000000000#bytes=0-0" as SourceRef
    },
    expected_file_hash: nullableString(row, "expected_file_hash") as Hash | null,
    expected_block_hash: nullableString(row, "expected_block_hash") as Hash | null,
    create_policy: nullableString(row, "create_policy") as Proposal["create_policy"],
    candidate_hash: stringField(row, "candidate_hash") as Hash,
    candidate_file_hash: stringField(row, "candidate_file_hash") as Hash,
    candidate_block_hash: nullableString(row, "candidate_block_hash") as Hash | null,
    diff: jsonColumn<Proposal["diff"]>(row["diff_json"]) ?? {
      format: "unified_diff",
      ref: "blob://sha256:0000000000000000000000000000000000000000000000000000000000000000#bytes=0-0" as SourceRef,
      hash: "" as Hash,
      applies_to_hash: "" as Hash
    },
    experience: jsonColumn<Proposal["experience"]>(row["experience_json"]) ?? {
      experience_id: "",
      version: 1,
      content_hash: "" as Hash,
      body_ref: "" as SourceRef,
      validation_plan_id: "",
      validation_plan_hash: "" as Hash,
      risk: "low",
      scope: { level: "project", project_ids: [], host_ids: [], modes: [], environment_fingerprints: [], tool_version_ranges: [], model_families: [] },
      verifier: { kind: "none", independence: "none" },
      no_verifier: true
    },
    normalization: jsonColumn<Proposal["normalization"]>(row["normalization_json"]) ?? {
      candidate_ref: "" as SourceRef,
      allocation: "created",
      risk_policy_ref: "" as SourceRef,
      scope_source_ref: "" as SourceRef,
      normalized_at: 0
    },
    experience_type: stringField(row, "experience_type") as Proposal["experience_type"],
    evidence_refs: jsonColumn<Proposal["evidence_refs"]>(row["evidence_refs_json"]) ?? [],
    generator: jsonColumn<Proposal["generator"]>(row["generator_json"]) ?? {
      backend_id: "",
      model_id: "",
      protocol_version: "rsi.generator_protocol/1",
      generator_version: ""
    },
    static_check: jsonColumn<Proposal["static_check"]>(row["static_check_json"]) ?? {
      status: "passed",
      errors: [],
      checked_at: 0
    },
    match_judge: jsonColumn<Proposal["match_judge"]>(row["match_judge_json"]) ?? {
      status: "not_required",
      route_id: null,
      route_hash: null,
      route_class: null,
      template_id: "qt.experience_match",
      template_version: "1.0.0",
      template_hash: "" as Hash
    },
    created_at: numberField(row, "created_at"),
    updated_at: numberField(row, "updated_at"),
    version: numberField(row, "version")
  };
  const baseRef = nullableString(row, "base_ref");
  if (baseRef !== null) proposal.base_ref = baseRef as SourceRef;
  const egress = nullableString(row, "egress_decision_ref");
  if (egress !== null) proposal.egress_decision_ref = egress as SourceRef;
  const handoff = nullableString(row, "handoff_id");
  if (handoff !== null) proposal.handoff_id = handoff;
  const adoption = nullableString(row, "adoption_ref");
  if (adoption !== null) proposal.adoption_ref = adoption;
  const stale = nullableString(row, "stale_reason");
  if (stale !== null) proposal.stale_reason = stale;
  return proposal;
}

function validationPlanFromRow(row: SqlRow): ValidationPlan {
  return {
    schema_version: "rsi.validation_plan/1",
    validation_plan_id: stringField(row, "validation_plan_id"),
    experience_id: stringField(row, "experience_id"),
    experience_version: numberField(row, "experience_version"),
    source_requirement_refs: jsonColumn<ValidationPlan["source_requirement_refs"]>(row["source_requirement_refs_json"]) ?? [],
    expected_behavior: stringField(row, "expected_behavior"),
    required_loading_evidence: jsonColumn<ValidationPlan["required_loading_evidence"]>(row["required_loading_evidence_json"]) ?? [],
    verifier: jsonColumn<ValidationPlan["verifier"]>(row["verifier_json"]) ?? {
      kind: "none",
      independence: "none",
      description: ""
    },
    observation_window: jsonColumn<ValidationPlan["observation_window"]>(row["observation_window_json"]) ?? {
      window_ms: 0,
      min_triggered_uses: 1,
      max_triggered_uses: 1,
      max_extensions: 0
    },
    retention_rule: jsonColumn<ValidationPlan["retention_rule"]>(row["retention_rule_json"]) ?? {
      rule_id: "",
      kind: "deterministic_check",
      min_independent_passes: 1,
      required_verifier_kinds: [],
      max_age_ms: 1
    },
    stop_conditions: jsonColumn<ValidationPlan["stop_conditions"]>(row["stop_conditions_json"]) ?? [],
    replay: jsonColumn<ValidationPlan["replay"]>(row["replay_json"]) ?? {
      requirement: "none",
      allowed_classes: [],
      live_external_policy: "observe_only"
    },
    plan_hash: stringField(row, "plan_hash") as Hash,
    created_at: numberField(row, "created_at")
  };
}

function experienceFromRow(row: SqlRow, body: Experience | null): Experience {
  if (body !== null) {
    const result: Experience = body;
    result.body_ref = stringField(row, "body_ref") as SourceRef;
    const superseded = nullableNumber(row, "superseded_by_version");
    if (superseded !== null) result.superseded_by_version = superseded;
    return result;
  }
  return {
    schema_version: "rsi.experience/1",
    experience_id: stringField(row, "experience_id"),
    version: numberField(row, "version"),
    lineage: jsonColumn<Experience["lineage"]>(row["lineage_json"]) ?? {
      kind: "create",
      source_job_id: "",
      source_proposal_id: "",
      source_snapshot_id: ""
    },
    type: stringField(row, "type") as Experience["type"],
    title: stringField(row, "title"),
    summary: stringField(row, "summary"),
    trigger: jsonColumn<Experience["trigger"]>(row["trigger_json"]) ?? {
      description: "",
      signal_kinds: [],
      task_family_ids: [],
      tool_names: [],
      path_patterns: [],
      negative_triggers: []
    },
    scope: jsonColumn<Experience["scope"]>(row["scope_json"]) ?? {
      level: "project",
      project_ids: [],
      host_ids: [],
      modes: [],
      environment_fingerprints: [],
      tool_version_ranges: [],
      model_families: []
    },
    preconditions: jsonColumn<Experience["preconditions"]>(row["preconditions_json"]) ?? [],
    steps: jsonColumn<Experience["steps"]>(row["steps_json"]) ?? [],
    expected_effects: jsonColumn<string[]>(row["expected_effects_json"]) ?? [],
    completion_check: jsonColumn<Experience["completion_check"]>(row["completion_check_json"]) ?? {
      kind: "none",
      description: ""
    },
    failure_branches: jsonColumn<Experience["failure_branches"]>(row["failure_branches_json"]) ?? [],
    counterexamples: jsonColumn<Experience["counterexamples"]>(row["counterexamples_json"]) ?? [],
    validation_plan_id: stringField(row, "validation_plan_id"),
    validation_plan_hash: stringField(row, "validation_plan_hash") as Hash,
    body_ref: stringField(row, "body_ref") as SourceRef,
    risk: stringField(row, "risk") as Experience["risk"],
    expiry_policy: jsonColumn<Experience["expiry_policy"]>(row["expiry_policy_json"]) ?? {
      invalidate_on_host_version_change: true,
      invalidate_on_tool_version_change: true,
      invalidate_on_model_family_change: true
    },
    evidence_refs: jsonColumn<Experience["evidence_refs"]>(row["evidence_refs_json"]) ?? [],
    content_hash: stringField(row, "content_hash") as Hash,
    created_at: numberField(row, "created_at")
  };
}

function usageFromRow(row: SqlRow): UsageVerificationRecord {
  return {
    schema_version: "rsi.usage_verification/1",
    usage_id: stringField(row, "usage_id"),
    usage_key: stringField(row, "usage_key") as Hash,
    projection_id: stringField(row, "projection_id"),
    experience_id: stringField(row, "experience_id"),
    experience_version: numberField(row, "experience_version"),
    experience_content_hash: stringField(row, "experience_content_hash") as Hash,
    validation_plan_id: stringField(row, "validation_plan_id"),
    validation_plan_hash: stringField(row, "validation_plan_hash") as Hash,
    version_binding: jsonColumn<VersionBinding>(row["version_binding_json"]) ?? {
      task_id: "" as Id<"task">,
      branch_id: "" as Id<"br">,
      input_epoch: 0,
      goal_version: "",
      config_version: "",
      watermark: 0
    },
    task_family_id: stringField(row, "task_family_id"),
    trigger_result: stringField(row, "trigger_result") as UsageVerificationRecord["trigger_result"],
    loading: jsonColumn<UsageVerificationRecord["loading"]>(row["loading_json"]) ?? {
      written: "unknown",
      discovered: "unknown",
      included: "unknown",
      observed: "unknown",
      evidence_refs: []
    },
    behavior: jsonColumn<UsageVerificationRecord["behavior"]>(row["behavior_json"]) ?? {
      evidence_refs: [],
      summary: ""
    },
    verification: jsonColumn<UsageVerificationRecord["verification"]>(row["verification_json"]) ?? {
      kind: "none",
      independence: "none",
      status: "not_available",
      binding_ref: "" as SourceRef,
      validation_plan_hash: "" as Hash,
      version_binding: {
        task_id: "" as Id<"task">,
        branch_id: "" as Id<"br">,
        input_epoch: 0,
        goal_version: "",
        config_version: "",
        watermark: 0
      }
    },
    other_change_refs: jsonColumn<SourceRef[]>(row["other_change_refs_json"]) ?? [],
    attribution: stringField(row, "attribution") as UsageVerificationRecord["attribution"],
    result: stringField(row, "result") as UsageVerificationRecord["result"],
    evidence_hash: stringField(row, "evidence_hash") as Hash,
    causal_supported: false,
    observed_at: numberField(row, "observed_at"),
    window_index: numberField(row, "window_index")
  };
}

function lifecycleEventFromRow(row: SqlRow): ExperienceLifecycleEvent {
  return {
    schema_version: "rsi.experience_lifecycle_event/1",
    event_id: stringField(row, "event_id") as Id<"lif">,
    projection_id: stringField(row, "projection_id"),
    experience_id: stringField(row, "experience_id"),
    experience_version: numberField(row, "experience_version"),
    experience_content_hash: stringField(row, "experience_content_hash") as Hash,
    adoption_binding_hash: stringField(row, "adoption_binding_hash") as Hash,
    sequence: numberField(row, "sequence"),
    from_lifecycle: nullableString(row, "from_lifecycle") as ExperienceLifecycleEvent["from_lifecycle"],
    to_lifecycle: stringField(row, "to_lifecycle") as ExperienceLifecycleEvent["to_lifecycle"],
    reason: stringField(row, "reason") as ExperienceLifecycleEvent["reason"],
    trigger: {
      kind: stringField(row, "trigger_kind") as ExperienceLifecycleEvent["trigger"]["kind"],
      ref: nullableString(row, "trigger_ref") as SourceRef | null,
      usage_ids: jsonColumn<string[]>(row["trigger_usage_ids_json"]) ?? []
    },
    write_id: stringField(row, "write_id") as Id<"wi">,
    version_binding: jsonColumn<VersionBinding>(row["version_binding_json"]) ?? {
      task_id: "" as Id<"task">,
      branch_id: "" as Id<"br">,
      input_epoch: 0,
      goal_version: "",
      config_version: "",
      watermark: 0
    },
    projection_before_hash: nullableString(row, "projection_before_hash") as Hash | null,
    projection_after_hash: stringField(row, "projection_after_hash") as Hash,
    projection_after: jsonColumn<ExperienceProjection>(row["projection_after_json"]) ?? projectionFromRow({
      projection_id: stringField(row, "projection_id"),
      schema_version: "rsi.experience_projection/2",
      experience_id: stringField(row, "experience_id"),
      experience_version: numberField(row, "experience_version"),
      experience_content_hash: stringField(row, "experience_content_hash") as Hash,
      host_id: "claude-code",
      config_space: "",
      mode: "exec",
      object_type: "skill",
      path_or_block: "",
      block_id: null,
      write_id: stringField(row, "write_id") as Id<"wi">,
      adoption_binding_json: "{}",
      adoption_binding_hash: "" as Hash,
      lifecycle: stringField(row, "to_lifecycle") as ExperienceProjection["lifecycle"],
      lifecycle_reason: stringField(row, "reason") as ExperienceProjection["lifecycle_reason"],
      checked_at: 0,
      write_json: "{}",
      loading_evidence_json: "{}",
      validation_plan_id: "",
      validation_plan_hash: "" as Hash,
      verifier_json: "{}",
      no_verifier: 1,
      retention_rule_id: "",
      retention_json: "{}",
      baseline_json: null,
      usage_record_ids_json: "[]",
      restored_from_projection_id: null,
      superseded_by_projection_id: null,
      last_lifecycle_event_id: "",
      causal_supported: 0,
      row_version: 1,
      created_at: 0,
      updated_at: 0
    }),
    row_version_before: numberField(row, "row_version_before"),
    row_version_after: numberField(row, "row_version_after"),
    recorded_at: numberField(row, "recorded_at"),
    event_hash: stringField(row, "event_hash") as Hash
  };
}

/* ------------------------------------------------------------------ */
/* SourceRef resolution                                                */
/* ------------------------------------------------------------------ */

function readSourceRef(
  connection: SqliteConnection,
  blobStore: BlobStore,
  ref: SourceRef
): Result<{ bytes: Uint8Array; content_hash: Hash; range_hash: Hash }, ErrorEnvelope> {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return parsed;
  }
  let full: Uint8Array;
  if (parsed.value.scheme === "blob") {
    const read = blobStore.read(parsed.value.locator as Hash);
    if (!read.ok) {
      return read;
    }
    full = read.value;
  } else {
    const row = one<SqlRow>(
      connection,
      "SELECT content_ref, content_bytes FROM event_log WHERE event_id = :event_id",
      { event_id: parsed.value.locator }
    );
    if (row === null) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_SOURCE_UNRETRIEVABLE",
          category: "source",
          message_key: "error.source_unretrievable",
          stage: "source_ref",
          retryable: false,
          side_effect: "none",
          details: { kind: "source", source_ref: ref, reason: "missing" }
        })
      };
    }
    const contentRef = nullableString(row, "content_ref");
    if (contentRef === null) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_SOURCE_UNRETRIEVABLE",
          category: "source",
          message_key: "error.source_unretrievable",
          stage: "source_ref",
          retryable: false,
          side_effect: "none",
          details: { kind: "source", source_ref: ref, reason: "missing" }
        })
      };
    }
    const nested = readSourceRef(connection, blobStore, contentRef as SourceRef);
    if (!nested.ok) {
      return nested;
    }
    full = nested.value.bytes;
  }
  if (parsed.value.end > full.byteLength) {
    return {
      ok: false,
      status: "rejected",
      error: makeErrorEnvelope({
        code: "E_SOURCE_UNRETRIEVABLE",
        category: "source",
        message_key: "error.source_unretrievable",
        stage: "source_ref",
        retryable: false,
        side_effect: "none",
        details: { kind: "source", source_ref: ref, reason: "out_of_range" }
      })
    };
  }
  const range = full.subarray(parsed.value.start, parsed.value.end);
  return {
    ok: true,
    status: "ok",
    value: {
      bytes: range,
      content_hash: hashBytes(full),
      range_hash: hashBytes(range)
    }
  };
}

/* ------------------------------------------------------------------ */
/* SQLite repository                                                   */
/* ------------------------------------------------------------------ */

function readBlobJson<T>(blobStore: BlobStore, ref: string | null): T | null {
  if (ref === null) return null;
  const parsed = parseSourceRef(ref);
  if (!parsed.ok || parsed.value.scheme !== "blob") return null;
  const bytes = blobStore.read(parsed.value.locator as Hash);
  if (!bytes.ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes.value)) as T;
  } catch {
    return null;
  }
}

/** Close-read repository over the same SQLite connection and blob store. */
export function createKernelHandoffCloseRepository(
  connection: SqliteConnection,
  blobStore: BlobStore
): import("@evoplug/review").HandoffCloseRepository {
  return {
    loadHandoff: (handoffId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_handoffs WHERE handoff_id = :id", {
        id: handoffId
      });
      if (row === null) return null;
      const bodyRef = nullableString(row, "body_blob");
      const handoff = readBlobJson<ReviewHandoff>(blobStore, bodyRef);
      if (handoff === null || bodyRef === null) return null;
      return { handoff, body_blob: bodyRef as SourceRef };
    },
    loadJob: (jobId) => {
      const row = one<SqlRow>(
        connection,
        "SELECT state, snapshot_id, terminal_at FROM review_jobs WHERE job_id = :id",
        { id: jobId }
      );
      if (row === null) return null;
      return {
        state: stringField(row, "state") as ReviewJob["state"],
        snapshot_id: stringField(row, "snapshot_id"),
        terminal_at: nullableNumber(row, "terminal_at")
      };
    },
    loadSnapshot: (snapshotId) => {
      const row = one<SqlRow>(
        connection,
        "SELECT snapshot_hash, version_binding_json, body_blob FROM review_snapshots WHERE snapshot_id = :id",
        { id: snapshotId }
      );
      if (row === null) return null;
      const body = readBlobJson<ReviewSnapshot>(blobStore, nullableString(row, "body_blob"));
      const binding = jsonColumn<VersionBinding>(row["version_binding_json"]);
      const resolved = binding ?? body?.version_binding;
      if (resolved === undefined) return null;
      return {
        snapshot_hash: stringField(row, "snapshot_hash") as Hash,
        version_binding: resolved,
        issues: (body?.issues ?? []).map((issue) => ({ issue_id: issue.issue_id }))
      };
    },
    loadProposal: (proposalId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM proposals WHERE proposal_id = :id", {
        id: proposalId
      });
      return row === null ? null : proposalFromRow(row);
    },
    loadStaleProposalIssueIds: (jobId) => {
      return all<SqlRow>(
        connection,
        "SELECT match_judge_json FROM proposals WHERE job_id = :id AND state = 'stale'",
        { id: jobId }
      )
        .map((row) => jsonColumn<{ issue_id?: string }>(row["match_judge_json"])?.issue_id)
        .filter((issueId): issueId is string => issueId !== undefined);
    }
  };
}

export function createSqliteReviewRepository(
  connection: SqliteConnection,
  blobStore: BlobStore
): ReviewRepository {
  const readBody = <T>(ref: string | null): T | null => {
    if (ref === null) return null;
    const parsed = parseSourceRef(ref);
    if (!parsed.ok || parsed.value.scheme !== "blob") return null;
    const bytes = blobStore.read(parsed.value.locator as Hash);
    if (!bytes.ok) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes.value)) as T;
    } catch {
      return null;
    }
  };

  return {
    getSnapshot: async (snapshotId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_snapshots WHERE snapshot_id = :id", { id: snapshotId });
      return row === null ? null : readBody<ReviewSnapshot>(nullableString(row, "body_blob"));
    },
    getJob: async (jobId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_jobs WHERE job_id = :id", { id: jobId });
      return row === null ? null : jobFromRow(row);
    },
    getJobByDedupeKey: async (key) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_jobs WHERE trigger_dedupe_key = :key", { key });
      return row === null ? null : jobFromRow(row);
    },
    getRequest: async (requestId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_enqueue_requests WHERE request_id = :id", { id: requestId });
      if (row === null) return null;
      const result = jsonColumn<JsonValue>(row["result_json"]);
      return {
        request_hash: stringField(row, "request_hash") as Hash,
        review_job_id: stringField(row, "review_job_id"),
        result_json: result ?? {}
      };
    },
    getAttempt: async (attemptId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_attempts WHERE attempt_id = :id", { id: attemptId });
      return row === null ? null : attemptFromRow(row);
    },
    getAcceptance: async (attemptId) => {
      const row = one<SqlRow>(
        connection,
        "SELECT * FROM review_output_acceptances WHERE attempt_id = :id",
        { id: attemptId }
      );
      if (row === null) return null;
      const parsed = parseSourceRef(stringField(row, "output_ref"));
      if (!parsed.ok) return null;
      return {
        attempt_id: stringField(row, "attempt_id"),
        job_id: stringField(row, "job_id"),
        output_ref: parsed.value.source_ref,
        output_hash: stringField(row, "output_hash") as Hash,
        candidate_count: numberField(row, "candidate_count"),
        attempt_version_before: numberField(row, "attempt_version_before"),
        attempt_version_after: numberField(row, "attempt_version_after"),
        job_version_before: numberField(row, "job_version_before"),
        job_version_after: numberField(row, "job_version_after"),
        job_stage_after: "static_check" as const,
        fencing_token: numberField(row, "fencing_token"),
        accepted_at: numberField(row, "accepted_at"),
        row_version: 1 as const
      };
    },
    listAttempts: async (jobId) => {
      return all<SqlRow>(connection, "SELECT * FROM review_attempts WHERE job_id = :id ORDER BY ordinal", { id: jobId })
        .map(attemptFromRow);
    },
    getCandidates: async (jobId) => {
      return all<SqlRow>(connection, "SELECT * FROM proposal_candidates WHERE job_id = :id ORDER BY ordinal", { id: jobId })
        .map(candidateFromRow);
    },
    getCandidateJson: async (candidate) => {
      const parsed = parseSourceRef(candidate.candidate_ref);
      if (!parsed.ok || parsed.value.scheme !== "blob") return null;
      const bytes = blobStore.read(parsed.value.locator as Hash);
      if (!bytes.ok) return null;
      const start = parsed.value.start;
      const end = parsed.value.end;
      if (end > bytes.value.byteLength) return null;
      try {
        return JSON.parse(new TextDecoder().decode(bytes.value.subarray(start, end))) as JsonValue;
      } catch {
        return null;
      }
    },
    getProposal: async (proposalId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM proposals WHERE proposal_id = :id", { id: proposalId });
      return row === null ? null : proposalFromRow(row);
    },
    listProposals: async (jobId) => {
      return all<SqlRow>(connection, "SELECT * FROM proposals WHERE job_id = :id ORDER BY ordinal", { id: jobId })
        .map(proposalFromRow);
    },
    getHandoff: async (handoffId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_handoffs WHERE handoff_id = :id", { id: handoffId });
      return row === null ? null : readBody<ReviewHandoff>(nullableString(row, "body_blob"));
    },
    getHandoffByJob: async (jobId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM review_handoffs WHERE job_id = :id", { id: jobId });
      return row === null ? null : readBody<ReviewHandoff>(nullableString(row, "body_blob"));
    },
    getProjection: async (projectionId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM experience_projections WHERE projection_id = :id", { id: projectionId });
      return row === null ? null : projectionFromRow(row as never);
    },
    getProjectionByWriteId: async (writeId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM experience_projections WHERE write_id = :id", { id: writeId });
      return row === null ? null : projectionFromRow(row as never);
    },
    listProjections: async (experienceId, version) => {
      return all<SqlRow>(
        connection,
        "SELECT * FROM experience_projections WHERE experience_id = :id AND experience_version = :version",
        { id: experienceId, version }
      ).map((row) => projectionFromRow(row as never));
    },
    getValidationPlan: async (planId) => {
      const row = one<SqlRow>(connection, "SELECT * FROM validation_plans WHERE validation_plan_id = :id", { id: planId });
      return row === null ? null : validationPlanFromRow(row);
    },
    listExperiences: async (experienceId) => {
      return all<SqlRow>(
        connection,
        "SELECT * FROM experiences WHERE experience_id = :id ORDER BY version",
        { id: experienceId }
      ).map((row) => {
        const body = readBody<Experience>(nullableString(row, "body_ref"));
        return experienceFromRow(row, body);
      });
    },
    listAdoptedVersions: async (experienceId) => {
      return all<{ version: number }>(
        connection,
        `SELECT DISTINCT experience_version AS version
           FROM experience_lifecycle_events
          WHERE experience_id = :id AND sequence = 1
            AND reason = 'adopted' AND to_lifecycle = 'checked'
          ORDER BY experience_version`,
        { id: experienceId }
      ).map((row) => row.version);
    },
    listUsage: async (projectionId) => {
      return all<SqlRow>(
        connection,
        "SELECT * FROM usage_verification_records WHERE projection_id = :id ORDER BY window_index",
        { id: projectionId }
      ).map(usageFromRow);
    },
    listLifecycleEvents: async (projectionId) => {
      return all<SqlRow>(
        connection,
        "SELECT * FROM experience_lifecycle_events WHERE projection_id = :id ORDER BY sequence",
        { id: projectionId }
      ).map(lifecycleEventFromRow);
    },
    findClaimableJob: async (now) => {
      const row = one<SqlRow>(
        connection,
        `SELECT * FROM review_jobs
          WHERE state IN ('queued','blocked_no_backend')
            AND (retry_after_at IS NULL OR retry_after_at <= :now)
          ORDER BY created_at, job_id
          LIMIT 1`,
        { now }
      );
      return row === null ? null : jobFromRow(row);
    },
    listExpiredAttempts: async (now) => {
      return all<SqlRow>(
        connection,
        `SELECT * FROM review_attempts
          WHERE state IN ('leased','running')
            AND lease_json IS NOT NULL
            AND CAST(json_extract(lease_json,'$.expires_at') AS INTEGER) < :now`,
        { now }
      ).map(attemptFromRow);
    },
    listJobsInStage: async (stage) => {
      return all<SqlRow>(connection, "SELECT * FROM review_jobs WHERE stage = :stage", { stage }).map(jobFromRow);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Journal-backed commit                                               */
/* ------------------------------------------------------------------ */

interface ReviewJournal {
  readonly writer: JournalWriter;
  readonly relativePath: string;
  readonly committer: JournalCommitter;
}

function openReviewJournal(layout: HomeLayout, connection: SqliteConnection, now: () => number): ReviewJournal | null {
  const states = listJournalStates(connection);
  const latest = states[states.length - 1];
  const journalId = latest?.journal_id ?? "journal-000001";
  const relativePath = latest?.relative_path ?? "journal-000001.rsij";
  const writer = JournalWriter.open({
    file_path: `${layout.journal_dir}/${relativePath}`,
    journal_id: journalId,
    last_commit_seq: latest?.last_commit_seq ?? 0,
    trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
    read_only: latest?.read_only === 1,
    tail_state: latest?.tail_state ?? "clean"
  });
  if (!writer.ok) {
    return null;
  }
  try {
    return {
      writer: writer.value,
      relativePath,
      committer: createJournalCommitter({
        writer: writer.value,
        connection,
        relative_path: relativePath,
        now
      })
    };
  } catch (error) {
    writer.value.close();
    throw error;
  }
}

interface ReviewJournalHandle {
  readonly journal: ReviewJournal | null;
  /** True when this composition opened the writer and must close it. */
  readonly owned: boolean;
  /** Closes an owned writer once; a borrowed writer is never closed. */
  close(): boolean;
}

function journalHandle(journal: ReviewJournal | null, owned: boolean): ReviewJournalHandle {
  let closed = false;
  return {
    journal,
    owned,
    close: (): boolean => {
      if (closed) {
        return false;
      }
      closed = true;
      if (!owned || journal === null) {
        return false;
      }
      journal.writer.close();
      return true;
    }
  };
}

function resolveReviewJournal(
  options: ReviewServiceOptions,
  layout: HomeLayout,
  connection: SqliteConnection,
  now: () => number
): ReviewJournalHandle {
  const borrowed = options.journal;
  if (borrowed !== undefined) {
    return journalHandle(
      {
        writer: borrowed.writer,
        relativePath: borrowed.relative_path,
        committer: borrowed.committer ?? createJournalCommitter({
          writer: borrowed.writer,
          connection,
          relative_path: borrowed.relative_path,
          now
        })
      },
      false
    );
  }
  return journalHandle(openReviewJournal(layout, connection, now), true);
}

interface CommitMember {
  readonly row_schema: string;
  readonly object_key: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  readonly binding: VersionBinding | null;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly expected: Readonly<Record<string, SqlValue>>;
  readonly blob_hashes: readonly Hash[];
}

interface StagedBlob {
  readonly bytes: Uint8Array;
  readonly ref: SourceRef;
  readonly owner_type: "review" | "experience";
  readonly owner_id: string;
}

const TABLE_BY_SCHEMA: Readonly<Record<string, { table: string; primary_key: readonly string[] }>> = {
  "rsi.review_snapshot/1": { table: "review_snapshots", primary_key: ["snapshot_id"] },
  "rsi.review_enqueue_request_row/1": { table: "review_enqueue_requests", primary_key: ["request_id"] },
  "rsi.review_job/2": { table: "review_jobs", primary_key: ["job_id"] },
  "rsi.review_attempt/1": { table: "review_attempts", primary_key: ["attempt_id"] },
  "rsi.proposal_candidate_row/1": { table: "proposal_candidates", primary_key: ["candidate_key"] },
  "rsi.proposal_row/2": { table: "proposals", primary_key: ["proposal_id"] },
  "rsi.review_output_acceptance_row/1": { table: "review_output_acceptances", primary_key: ["attempt_id"] },
  "rsi.experience_row/1": { table: "experiences", primary_key: ["experience_id", "version"] },
  "rsi.validation_plan_row/1": { table: "validation_plans", primary_key: ["validation_plan_id"] },
  "rsi.usage_verification_row/1": { table: "usage_verification_records", primary_key: ["usage_id"] },
  "rsi.experience_lifecycle_event_row/1": { table: "experience_lifecycle_events", primary_key: ["event_id"] },
  "rsi.experience_projection/2": { table: "experience_projections", primary_key: ["projection_id"] },
  "rsi.review_handoff/2": { table: "review_handoffs", primary_key: ["handoff_id"] }
};

/**
 * FK-safe SQL execution order for one state-row batch. Validation plans and
 * Experiences have no inbound batch FK, Proposals reference the attempt/job
 * that already exist, and candidates reference the Proposal/Experience rows
 * inserted in the same batch. Journal member ordering remains the storage
 * layer's deterministic order.
 */
function memberExecutionRank(rowSchema: string): number {
  switch (rowSchema) {
    case "rsi.validation_plan_row/1":
      return 0;
    case "rsi.experience_row/1":
      return 1;
    case "rsi.proposal_row/2":
      return 2;
    case "rsi.proposal_candidate_row/1":
      return 3;
    default:
      return 4;
  }
}

function sqlForMember(member: CommitMember): { sql: string; params: Record<string, SqlValue> } {  const params: Record<string, SqlValue> = {};
  const keys = Object.keys(member.row);
  for (const key of keys) {
    params[key] = sqlValue(member.row[key]);
  }
  if (member.operation === "insert") {
    const columns = keys.join(", ");
    const values = keys.map((key) => `:${key}`).join(", ");
    return { sql: `INSERT INTO ${member.table} (${columns}) VALUES (${values})`, params };
  }
  const setters = keys
    .filter((key) => !member.primary_key.includes(key))
    .map((key) => `${key} = :${key}`)
    .join(", ");
  const where = member.primary_key
    .map((key) => {
      if (key in member.expected) {
        params[`expected_${key}`] = member.expected[key] ?? null;
        return `${key} = :expected_${key}`;
      }
      return `${key} = :${key}`;
    })
    .join(" AND ");
  return { sql: `UPDATE ${member.table} SET ${setters} WHERE ${where}`, params };
}

function eventForMember(member: CommitMember, now: number): JsonValue {
  const rowJson = canonicalJsonText(member.row);
  const afterHash = canonicalHash({ row_schema: member.row_schema, row_json: rowJson });
  const beforeHash = member.before === null
    ? null
    : canonicalHash({ row_schema: member.row_schema, row_json: canonicalJsonText(member.before) });
  const eventId = newId("ev", now);
  const binding = member.binding === null
    ? null
    : {
        task_id: member.binding.task_id,
        branch_id: member.binding.branch_id,
        input_epoch: member.binding.input_epoch,
        goal_version: member.binding.goal_version,
        config_version: member.binding.config_version,
        watermark: member.binding.watermark
      };
  const event = {
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: canonicalHash({
      event_id: eventId,
      row_schema: member.row_schema,
      object_key: member.object_key,
      after_hash: afterHash
    }) as Hash,
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: member.object_key,
    operation: member.operation,
    binding,
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: member.row_schema,
    row_json: rowJson,
    payload_hash: afterHash,
    recorded_at: now
  };
  return toJsonValue(event);
}

function insertLedgerEvent(
  tx: Tx,
  event: JsonValue,
  commitSeq: number,
  journalId: string
): void {
  const object = event as Record<string, JsonValue>;
  const binding = object["binding"];
  const bound = typeof binding === "object" && binding !== null && !Array.isArray(binding)
    ? binding as Record<string, JsonValue>
    : null;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: sqlValue(object["event_id"]),
    event_key: sqlValue(object["event_key"]),
    commit_seq: commitSeq,
    journal_id: journalId,
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: sqlValue(object["entity_id"]),
    operation: sqlValue(object["operation"]),
    binding_mode: bound === null ? "global" : "bound",
    task_id: bound === null ? null : sqlValue(bound["task_id"]),
    branch_id: bound === null ? null : sqlValue(bound["branch_id"]),
    input_epoch: bound === null ? null : sqlValue(bound["input_epoch"]),
    goal_version: bound === null ? null : sqlValue(bound["goal_version"]),
    config_version: bound === null ? null : sqlValue(bound["config_version"]),
    watermark: bound === null ? null : sqlValue(bound["watermark"]),
    before_hash: sqlValue(object["before_hash"]),
    after_hash: sqlValue(object["after_hash"]),
    row_schema: sqlValue(object["row_schema"]),
    row_json: sqlValue(object["row_json"]),
    payload_hash: sqlValue(object["payload_hash"]),
    recorded_at: sqlValue(object["recorded_at"])
  });
}

function insertStagedBlob(tx: Tx, blobStore: BlobStore, blob: StagedBlob, now: number): void {
  const parsed = parseSourceRef(blob.ref);
  if (!parsed.ok || parsed.value.scheme !== "blob") {
    return;
  }
  const hash = parsed.value.locator as Hash;
  const length = blob.bytes.byteLength;
  const relative = blobStore.relativePath(hash);
  tx.prepare(
    `INSERT INTO blob (blob_hash, byte_length, relative_path, state, verified_at, created_at)
     VALUES (:hash, :length, :relative, 'present', :now, :now)
     ON CONFLICT(blob_hash) DO NOTHING`
  ).run({ hash, length, relative, now });
  tx.prepare(
    `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
     VALUES (:hash, :owner_type, :owner_id, :source_ref, :now)
     ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
  ).run({
    hash,
    owner_type: blob.owner_type,
    owner_id: blob.owner_id,
    source_ref: blob.ref,
    now
  });
}

function reserveExperienceVersions(
  tx: Tx,
  proposals: readonly Proposal[],
  now: number
): ErrorEnvelope | null {
  const seen = new Set<string>();
  for (const proposal of proposals) {
    const experienceId = String(proposal.experience.experience_id);
    const version = proposal.experience.version;
    const key = `${experienceId}:${String(version)}`;
    if (seen.has(key)) return storageUnavailable("experience_version_allocator.duplicate_batch_version");
    seen.add(key);

    const allocator = tx
      .prepare<{ next_version: number; row_version: number }>(
        "SELECT next_version, row_version FROM experience_version_allocators WHERE experience_id = :id"
      )
      .get({ id: experienceId });
    if (allocator === undefined) {
      const maximum = tx
        .prepare<{ maximum: number | null }>(
          "SELECT MAX(version) AS maximum FROM experiences WHERE experience_id = :id AND version <> :version"
        )
        .get({ id: experienceId, version });
      const expected = maximum?.maximum === null || maximum?.maximum === undefined ? 1 : maximum.maximum + 1;
      if (version !== expected) return storageUnavailable("experience_version_allocator.version_conflict");
      tx.prepare(
        `INSERT INTO experience_version_allocators
           (experience_id, next_version, row_version, updated_at)
         VALUES (:id, :next_version, 1, :updated_at)`
      ).run({ id: experienceId, next_version: version + 1, updated_at: now });
      continue;
    }
    if (allocator.next_version !== version) {
      return storageUnavailable("experience_version_allocator.version_conflict");
    }
    const updated = tx
      .prepare(
        `UPDATE experience_version_allocators
            SET next_version = :next_version,
                row_version = row_version + 1,
                updated_at = :updated_at
          WHERE experience_id = :id AND row_version = :row_version AND next_version = :version`
      )
      .run({
        id: experienceId,
        version,
        next_version: version + 1,
        row_version: allocator.row_version,
        updated_at: now
      });
    if (Number(updated.changes) !== 1) return storageUnavailable("experience_version_allocator.cas_conflict");
  }
  return null;
}

async function commitReviewMembers(input: {
  journal: ReviewJournal | null;
  connection: SqliteConnection;
  blobStore: BlobStore;
  members: readonly CommitMember[];
  blobs: readonly StagedBlob[];
  now: number;
  /**
   * Derived rows (projection, handoff close view) are materialised inside the
   * same SQLite transaction but are not journal members (DD-REV-151). The
   * callback runs after the member rows so foreign keys always see them.
   */
  apply?: (tx: Tx, receipt: { first_commit_seq: number; journal_id: string }) => ErrorEnvelope | null;
}): Promise<Result<void, ErrorEnvelope>> {
  if (input.members.length === 0 && input.blobs.length === 0 && input.apply === undefined) {
    return ok(undefined);
  }
  if (input.journal === null) {
    return { ok: false, status: "rejected", error: storageUnavailable("review_journal_unavailable") };
  }
  // `insertStagedBlob` writes only the blob/blob_ref metadata rows. Materialise
  // the bytes first so a committed row never points at a dangling file; the
  // store is content addressed, so callers that already wrote them are a no-op.
  for (const blob of input.blobs) {
    const parsed = parseSourceRef(blob.ref);
    if (!parsed.ok || parsed.value.scheme !== "blob") continue;
    const stored = input.blobStore.putSync(blob.bytes);
    if (!stored.ok) {
      return { ok: false, status: "rejected", error: stored.error };
    }
    if (stored.value.hash !== parsed.value.locator) {
      return {
        ok: false,
        status: "rejected",
        error: unavailable("review_blob_materialize", "ref_hash_mismatch")
      };
    }
  }
  const members = orderStateRowBatchMembers(
    input.members.map((member) => {
      const event = eventForMember(member, input.now);
      return {
        event,
        event_hash: canonicalHash(event),
        blob_hashes: [...member.blob_hashes]
      };
    })
  );
  const memberHashes = members.map((member) => stateRowBatchMemberHash(member));
  const payload: JournalFramePayload = {
    schema_version: "rsi.state_row_batch/1",
    member_count: members.length,
    batch_hash: stateRowBatchHash(memberHashes),
    members
  };
  const outcome = await input.journal.committer.commit(payload, (tx, receipt) => {
    for (const [index, member] of members.entries()) {
      insertLedgerEvent(tx, member.event, receipt.first_commit_seq + index, input.journal?.writer.journalId ?? "");
    }
    for (const blob of input.blobs) {
      insertStagedBlob(tx, input.blobStore, blob, input.now);
    }
    // Execute the member SQL in dependency order: a candidate transition
    // references the Experience and Proposal inserted in the same batch, so
    // it must run after them even though the journal payload keeps its own
    // deterministic order.
    const executionOrder = input.members
      .map((member, index) => ({ member, index, rank: memberExecutionRank(member.row_schema) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index);
    for (const { member } of executionOrder) {
      const statement = sqlForMember(member);
      tx.prepare(statement.sql).run(statement.params);
    }
    if (input.apply !== undefined) {
      return input.apply(tx, {
        first_commit_seq: receipt.first_commit_seq,
        journal_id: input.journal?.writer.journalId ?? ""
      });
    }
    return null;
  });
  if (!outcome.ok) {
    return { ok: false, status: "rejected", error: outcome.error };
  }
  return ok(undefined);
}

/* ------------------------------------------------------------------ */
/* State-row commit seam (Experience ports)                            */
/* ------------------------------------------------------------------ */

/**
 * One Experience-owned state row. `table`, `primary_key`, `before`, `binding`
 * and `expected` are optional so callers only supply the row they know; they
 * default to the REV state-row table registry and an insert/compare-free
 * update.
 */
export interface ReviewStateRowInput {
  readonly row_schema: string;
  readonly object_key?: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row: Record<string, JsonValue>;
  readonly before?: Record<string, JsonValue> | null;
  readonly binding?: VersionBinding | null;
  readonly table?: string;
  readonly primary_key?: readonly string[];
  readonly expected?: Readonly<Record<string, SqlValue>>;
  readonly blob_hashes?: readonly Hash[];
}

export interface ReviewStateBlobInput {
  readonly bytes: Uint8Array;
  readonly ref: SourceRef;
  readonly owner_type?: "review" | "experience";
  readonly owner_id?: string;
}

export type ReviewStateRowCommit = (input: {
  members: readonly ReviewStateRowInput[];
  blobs: readonly ReviewStateBlobInput[];
  apply?: (tx: Tx) => ErrorEnvelope | null;
}) => Promise<Result<void, ErrorEnvelope>>;

/**
 * Minimal atomic commit seam for independent Experience port modules. It
 * reuses the same single-frame state-row batch and SQLite transaction as the
 * REV write port, so Experience rows and their blobs commit together.
 */
export function createReviewStateRowCommit(input: {
  journal: ReviewJournal | null;
  connection: SqliteConnection;
  blobStore: BlobStore;
  now: () => number;
}): ReviewStateRowCommit {
  return async (batch) => {
    const members: CommitMember[] = [];
    for (const entry of batch.members) {
      const registry = TABLE_BY_SCHEMA[entry.row_schema];
      const table = entry.table ?? registry?.table;
      const primaryKey = entry.primary_key ?? registry?.primary_key;
      if (table === undefined || primaryKey === undefined) {
        return {
          ok: false,
          status: "rejected",
          error: unavailable("experience_commit", `unknown_row_schema:${entry.row_schema}`)
        };
      }
      const firstKey = primaryKey[0];
      const objectKey = entry.object_key
        ?? (firstKey === undefined ? entry.row_schema : String(entry.row[firstKey] ?? entry.row_schema));
      members.push({
        row_schema: entry.row_schema,
        object_key: objectKey,
        operation: entry.operation,
        row: entry.row,
        before: entry.before ?? null,
        binding: entry.binding ?? null,
        table,
        primary_key: primaryKey,
        expected: entry.expected ?? {},
        blob_hashes: entry.blob_hashes ?? []
      });
    }
    const blobs: StagedBlob[] = batch.blobs.map((blob) => ({
      bytes: blob.bytes,
      ref: blob.ref,
      owner_type: blob.owner_type ?? "experience",
      owner_id: blob.owner_id ?? "experience"
    }));
    return commitReviewMembers({
      journal: input.journal,
      connection: input.connection,
      blobStore: input.blobStore,
      members,
      blobs,
      now: input.now(),
      ...(batch.apply === undefined
        ? {}
        : { apply: (tx: Tx) => batch.apply?.(tx) ?? null })
    });
  };
}

/* ------------------------------------------------------------------ */
/* Budget ledger                                                       */
/* ------------------------------------------------------------------ */

interface BudgetLedgerEventInput {
  readonly event_type: "budget.reserved" | "budget.claimed" | "budget.settled" | "budget.released" | "budget.unsettled";
  readonly operation: "insert" | "transition";
  readonly binding: VersionBinding;
  readonly reservation_id: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  readonly apply: (tx: Tx) => void;
}

function bindingJson(binding: VersionBinding): Record<string, JsonValue> {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

function insertGenericLedgerLog(
  tx: Tx,
  event: Record<string, JsonValue>,
  input: BudgetLedgerEventInput,
  commitSeq: number,
  journalId: string
): void {
  const binding = input.binding;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, 'bound', :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: sqlValue(event["event_id"]),
    event_key: sqlValue(event["event_key"]),
    commit_seq: commitSeq,
    journal_id: journalId,
    event_type: input.event_type,
    entity_type: "budget_reservation",
    entity_id: input.reservation_id,
    operation: input.operation,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    before_hash: sqlValue(event["before_hash"]),
    after_hash: sqlValue(event["after_hash"]),
    row_schema: "rsi.budget_reservation/1",
    row_json: sqlValue(event["row_json"]),
    payload_hash: sqlValue(event["payload_hash"]),
    recorded_at: sqlValue(event["recorded_at"])
  });
}

/**
 * Budget rows are FND ledger events, not REV state rows: they use a single
 * `rsi.journal_event/1` frame (DD-FND-080), never a state-row batch.
 */
async function commitBudgetEvent(input: {
  journal: ReviewJournal | null;
  event: BudgetLedgerEventInput;
  now: number;
}): Promise<Result<void, ErrorEnvelope>> {
  if (input.journal === null) {
    return { ok: false, status: "rejected", error: storageUnavailable("review_journal_unavailable") };
  }
  const rowJson = canonicalJsonText(input.event.row);
  const afterHash = canonicalHash({ row_schema: "rsi.budget_reservation/1", row_json: rowJson });
  const beforeHash = input.event.before === null
    ? null
    : canonicalHash({
        row_schema: "rsi.budget_reservation/1",
        row_json: canonicalJsonText(input.event.before)
      });
  const eventId = newId("ev", input.now);
  const eventKey = canonicalHash({
    event_type: input.event.event_type,
    entity_type: "budget_reservation",
    entity_id: input.event.reservation_id,
    operation: input.event.operation,
    before_hash: beforeHash,
    after_hash: afterHash,
    binding: bindingJson(input.event.binding)
  });
  const event: JsonValue = {
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: eventKey,
    event_type: input.event.event_type,
    entity_type: "budget_reservation",
    entity_id: input.event.reservation_id,
    operation: input.event.operation,
    binding: bindingJson(input.event.binding),
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: "rsi.budget_reservation/1",
    row_json: rowJson,
    payload_hash: afterHash,
    recorded_at: input.now
  };
  const payload: JournalFramePayload = {
    schema_version: "rsi.journal_event/1",
    event,
    event_hash: canonicalHash(event),
    blob_hashes: []
  };
  const journal = input.journal;
  const outcome = await journal.committer.commit(payload, (tx, receipt) => {
    insertGenericLedgerLog(tx, event as Record<string, JsonValue>, input.event, receipt.first_commit_seq, journal.writer.journalId);
    input.event.apply(tx);
    return null;
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: outcome.commit_state === "unknown_recovery_required" ? "unknown" : "rejected",
      error: outcome.error
    };
  }
  return ok(undefined);
}

function loadBudgetPolicy(connection: SqliteConnection): Result<BudgetPolicy, ErrorEnvelope> {
  const row = one<SqlRow>(connection, "SELECT canonical_json, content_hash FROM budget_policy WHERE active = 1");
  if (row === null) {
    return {
      ok: false,
      status: "rejected",
      error: budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } })
    };
  }
  const json = jsonColumn<JsonValue>(nullableString(row, "canonical_json"));
  if (json === null) {
    return {
      ok: false,
      status: "rejected",
      error: budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } })
    };
  }
  const parsed = parseBudgetPolicy(json);
  if (!parsed.ok) return parsed;
  if (budgetPolicyContentHash(parsed.value) !== stringField(row, "content_hash")) {
    return {
      ok: false,
      status: "rejected",
      error: budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_policy_read", details: { kind: "none" } })
    };
  }
  return parsed;
}

function asTx(connection: SqliteConnection): Tx {
  return {
    prepare: ((sql: string) => connection.prepare(sql)) as unknown as Tx["prepare"],
    exec: (sql: string) => connection.exec(sql)
  };
}

function budgetReservationRow(reservation: BudgetReservation, scope: BudgetPolicy["scopes"][number], profileHash: Hash): Record<string, JsonValue> {
  const binding = reservation.binding;
  return {
    reservation_id: reservation.reservation_id,
    reservation_key: reservation.reservation_key,
    policy_version: reservation.policy_version,
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
    purpose: reservation.purpose,
    scope_key: "",
    service_profile_id: "",
    service_profile_hash: profileHash,
    state: reservation.state,
    attempt_allowance: reservation.attempts_remaining,
    input_token_allowance: reservation.input_tokens_remaining,
    output_token_allowance: reservation.output_tokens_remaining,
    cost_allowance_micros: reservation.cost_micros_remaining,
    cost_status: reservation.cost_status,
    wall_allowance_ms: scope.wall_ms,
    non_refundable: 1,
    created_at: reservation.created_at,
    expires_at: reservation.expires_at,
    settled_at: reservation.state === "settled" ? reservation.created_at : null
  };
}

function planReservationRowUpdate(reservation: BudgetReservation, before: Record<string, JsonValue>): Record<string, JsonValue> {
  const row = { ...before };
  row["state"] = reservation.state;
  row["attempt_allowance"] = reservation.attempts_remaining;
  row["input_token_allowance"] = reservation.input_tokens_remaining;
  row["output_token_allowance"] = reservation.output_tokens_remaining;
  row["cost_allowance_micros"] = reservation.cost_micros_remaining;
  row["cost_status"] = reservation.cost_status;
  return row;
}

function updateReservationRow(tx: Tx, reservation: BudgetReservation): void {
  tx.prepare(
    `UPDATE budget_reservation SET
       state = :state, attempt_allowance = :attempt_allowance,
       input_token_allowance = :input_token_allowance,
       output_token_allowance = :output_token_allowance,
       cost_allowance_micros = :cost_allowance_micros, cost_status = :cost_status
     WHERE reservation_id = :reservation_id`
  ).run({
    state: reservation.state,
    attempt_allowance: reservation.attempts_remaining,
    input_token_allowance: reservation.input_tokens_remaining,
    output_token_allowance: reservation.output_tokens_remaining,
    cost_allowance_micros: reservation.cost_micros_remaining,
    cost_status: reservation.cost_status,
    reservation_id: reservation.reservation_id
  });
}

function insertAllowanceCharge(tx: Tx, charge: AllowanceCharge): void {
  tx.prepare(
    `INSERT INTO allowance_charge (
       charge_id, charge_key, reservation_id, kind, amount, non_refundable, reason, charged_at
     ) VALUES (
       :charge_id, :charge_key, :reservation_id, :kind, :amount, :non_refundable, :reason, :charged_at
     )`
  ).run({
    charge_id: charge.charge_id,
    charge_key: charge.charge_key,
    reservation_id: charge.reservation_id,
    kind: charge.kind,
    amount: charge.amount,
    non_refundable: charge.non_refundable ? 1 : 0,
    reason: charge.reason,
    charged_at: charge.charged_at
  });
}

function insertProviderUsage(tx: Tx, reservationId: Id<"resv">, usage: ProviderUsage): void {
  tx.prepare(
    `INSERT INTO provider_usage (
       usage_id, reservation_id, usage_key, attempt_ref, provider_request_id,
       input_tokens, output_tokens, cost_micros, cost_status, source, receipt_ref, recorded_at
     ) VALUES (
       :usage_id, :reservation_id, :usage_key, :attempt_ref, :provider_request_id,
       :input_tokens, :output_tokens, :cost_micros, :cost_status, :source, :receipt_ref, :recorded_at
     )`
  ).run({
    usage_id: newId("puse", usage.recorded_at),
    reservation_id: reservationId,
    usage_key: usage.usage_key,
    attempt_ref: usage.attempt_ref,
    provider_request_id: usage.provider_request_id,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_micros: usage.cost_micros,
    cost_status: usage.cost_status,
    source: usage.source,
    receipt_ref: usage.receipt_ref,
    recorded_at: usage.recorded_at
  });
}

/* ------------------------------------------------------------------ */
/* Write port                                                          */
/* ------------------------------------------------------------------ */

export function createSqliteReviewWritePort(input: {
  connection: SqliteConnection;
  blobStore: BlobStore;
  journal: ReviewJournal | null;
  now: () => number;
}): ReviewWritePort {
  const { connection, blobStore, journal, now } = input;

  const baseMember = (
    row_schema: string,
    object_key: string,
    row: Record<string, JsonValue>,
    operation: CommitMember["operation"],
    before: Record<string, JsonValue> | null,
    expected: Readonly<Record<string, SqlValue>>,
    binding: VersionBinding | null = null,
    blob_hashes: readonly Hash[] = []
  ): CommitMember | null => {
    const table = TABLE_BY_SCHEMA[row_schema];
    if (table === undefined) return null;
    return {
      row_schema,
      object_key,
      operation,
      row,
      before,
      binding,
      table: table.table,
      primary_key: table.primary_key,
      expected,
      blob_hashes
    };
  };

  const commitOne = async (
    row_schema: string,
    object_key: string,
    row: Record<string, JsonValue>,
    operation: CommitMember["operation"],
    before: Record<string, JsonValue> | null,
    expected: Readonly<Record<string, SqlValue>>,
    blobs: readonly StagedBlob[] = []
  ): Promise<Result<void, ErrorEnvelope>> => {
    const member = baseMember(row_schema, object_key, row, operation, before, expected);
    if (member === null) {
      return { ok: false, status: "rejected", error: unavailable("review_write", `review_write_schema:${row_schema}`) };
    }
    return commitReviewMembers({
      journal,
      connection,
      blobStore,
      members: [member],
      blobs,
      now: now()
    });
  };

  return {
    saveSnapshot: async (snapshot) => {
      const bytes = canonicalJson(toJsonValue(snapshot));
      const ref = blobRef(hashBytes(bytes), bytes.byteLength);
      const row = toJsonObject(snapshotRowFromSnapshot(snapshot, ref));
      return commitOne("rsi.review_snapshot/1", snapshot.snapshot_id, row, "insert", null, {}, [
        { bytes, ref, owner_type: "review", owner_id: snapshot.snapshot_id }
      ]);
    },
    saveJob: async (job, expectedVersion) => {
      const row = toJsonObject(jobRowFromJob(job));
      return commitOne("rsi.review_job/2", job.job_id, row, "update", null, { version: expectedVersion });
    },
    saveAttempt: async (attempt, expectedRowVersion) => {
      const row = toJsonObject(attemptRowFromAttempt(attempt));
      // The first save of a claimed Attempt has no row yet (`expected=0`);
      // every later save is a compare-and-swap update. Treating the first
      // save as an UPDATE silently wrote no row and made the lease look lost
      // on the very next read.
      return expectedRowVersion === 0
        ? commitOne("rsi.review_attempt/1", attempt.attempt_id, row, "insert", null, {})
        : commitOne("rsi.review_attempt/1", attempt.attempt_id, row, "update", null, { row_version: expectedRowVersion });
    },
    insertAcceptance: async (rowIn) => {
      const row = toJsonObject(rowIn);
      return commitOne("rsi.review_output_acceptance_row/1", rowIn.attempt_id, row, "insert", null, {});
    },
    saveCandidate: async (record, expectedRowVersion) => {
      const row = toJsonObject(candidateRowFromRecord(record));
      return commitOne("rsi.proposal_candidate_row/1", record.candidate_key, row, "update", null, {
        row_version: expectedRowVersion
      });
    },
    saveProposal: async (proposal, expectedVersion) => {
      const row = toJsonObject(proposalRowFromProposal(proposal));
      return commitOne("rsi.proposal_row/2", proposal.proposal_id, row, "update", null, { version: expectedVersion });
    },
    saveExperience: async (experience) => {
      const row = toJsonObject(experienceRowFromExperience(experience));
      return commitOne("rsi.experience_row/1", `${experience.experience_id}:${String(experience.version)}`, row, "insert", null, {});
    },
    saveValidationPlan: async (plan) => {
      const row = toJsonObject(validationPlanRowFromPlan(plan));
      return commitOne("rsi.validation_plan_row/1", plan.validation_plan_id, row, "insert", null, {});
    },
    saveHandoff: async (handoff, bodyRef) => {
      const row = toJsonObject(handoffRowFromHandoff(handoff, bodyRef));
      return commitOne("rsi.review_handoff/2", handoff.handoff_id, row, "insert", null, {});
    },
    saveProjection: async (projection, expectedRowVersion) => {
      const row = toJsonObject(projectionRowFromProjection(projection));
      return commitOne("rsi.experience_projection/2", projection.projection_id, row, "update", null, {
        row_version: expectedRowVersion
      });
    },
    saveUsage: async (record) => {
      const row = toJsonObject(usageRowFromRecord(record));
      return commitOne("rsi.usage_verification_row/1", record.usage_id, row, "insert", null, {});
    },
    saveLifecycleEvent: async (event, eventBlob) => {
      const row = toJsonObject(lifecycleEventRowFromEvent(event, eventBlob));
      return commitOne("rsi.experience_lifecycle_event_row/1", event.event_id, row, "insert", null, {});
    }
  };
}

/* ------------------------------------------------------------------ */
/* HOST/FND read ports                                                 */
/* ------------------------------------------------------------------ */

function createGoalPort(connection: SqliteConnection): GoalVersionReadPort {
  const read = (taskId: Id<"task">, branchId: Id<"br">): Result<CurrentGoalView, ErrorEnvelope> => {
    const row = one<SqlRow>(
      connection,
      `SELECT b.task_id, b.branch_id, b.current_goal_version, b.current_goal_revision,
              b.current_goal_snapshot_id, COALESCE((SELECT MAX(watermark) FROM event_log), 0) AS watermark
         FROM branch b WHERE b.task_id = :task_id AND b.branch_id = :branch_id`,
      { task_id: taskId, branch_id: branchId }
    );
    if (row === null) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_VERSION_BINDING",
          category: "version",
          message_key: "error.version_binding",
          stage: "binding",
          retryable: false,
          side_effect: "none",
          details: { kind: "version", expected: "branch", actual: "missing" }
        })
      };
    }
    return ok({
      schema_version: "rsi.current_goal_view/1",
      task_id: taskId,
      branch_id: branchId,
      goal_version: stringField(row, "current_goal_version"),
      goal_revision: numberField(row, "current_goal_revision"),
      goal_snapshot_id: nullableString(row, "current_goal_snapshot_id"),
      observed_watermark: numberField(row, "watermark")
    });
  };
  return {
    getCurrentGoal: async (input) => read(input.task_id, input.branch_id),
    getCurrentGoalInTransaction: (_tx, input) => read(input.task_id, input.branch_id)
  };
}

function createConfigPort(connection: SqliteConnection): ConfigVersionReadPort {
  const read = (configSpace: string): Result<ConfigVersionView, ErrorEnvelope> => {
    const row = one<SqlRow>(
      connection,
      `SELECT config_version, content_hash FROM config_profile
        WHERE config_space = :config_space AND status = 'active'
        ORDER BY created_at DESC LIMIT 1`,
      { config_space: configSpace }
    );
    if (row === null) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_VERSION_BINDING",
          category: "version",
          message_key: "error.version_binding",
          stage: "binding",
          retryable: false,
          side_effect: "none",
          details: { kind: "version", expected: configSpace, actual: "missing" }
        })
      };
    }
    return ok({
      schema_version: "rsi.config_version_view/1",
      config_space: configSpace,
      config_version: stringField(row, "config_version"),
      content_hash: stringField(row, "content_hash") as Hash
    });
  };
  return {
    getCurrentConfigVersion: async (input) => read(input.config_space),
    getCurrentConfigVersionInTransaction: (_tx, input) => read(input.config_space)
  };
}

function createSourceBytesPort(blobStore: BlobStore): { read(ref: SourceRef, opts?: { maxBytes?: number }): Promise<Result<Uint8Array, ErrorEnvelope>> } {
  return {
    read: async (ref, opts) => {
      const parsed = parseSourceRef(ref);
      if (!parsed.ok) return parsed;
      if (parsed.value.scheme !== "blob") {
        return {
          ok: false,
          status: "rejected",
          error: makeErrorEnvelope({
            code: "E_SOURCE_UNRETRIEVABLE",
            category: "source",
            message_key: "error.source_unretrievable",
            stage: "source_ref",
            retryable: false,
            side_effect: "none",
            details: { kind: "source", source_ref: ref, reason: "missing" }
          })
        };
      }
      const bytes = blobStore.read(parsed.value.locator as Hash);
      if (!bytes.ok) return bytes;
      const length = parsed.value.end - parsed.value.start;
      if (length > (opts?.maxBytes ?? 33_554_432) || parsed.value.end > bytes.value.byteLength) {
        return {
          ok: false,
          status: "rejected",
          error: makeErrorEnvelope({
            code: "E_SOURCE_TOO_LARGE",
            category: "source",
            message_key: "error.source_too_large",
            stage: "source_ref",
            retryable: false,
            side_effect: "none",
            details: { kind: "source", source_ref: ref, reason: "too_large" }
          })
        };
      }
      return ok(bytes.value.subarray(parsed.value.start, parsed.value.end));
    }
  };
}

/**
 * FND budget ledger used by the REV claim path (DD-REV-033, DD-FND-080).
 *
 * The ledger stays authoritative: every reservation/claim/settle writes one
 * `rsi.journal_event/1` frame and its SQLite rows in the same transaction.
 * Without an active `bpol/1` policy the port fails closed with
 * `E_BUDGET_POLICY_UNAVAILABLE`; it never invents a policy.
 */
export function createReviewBudgetPort(input: {
  connection: SqliteConnection;
  journal: ReviewJournal | null;
  now: () => number;
}): import("@evoplug/review").BudgetLedgerPort {
  const { connection, journal, now } = input;
  const tokenBuckets = new Map<string, { tokens: number; last_refill_ms: number }>();
  const providerScopeByReservation = new Map<string, string>();
  let claimChain: Promise<unknown> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = claimChain.then(fn, fn);
    claimChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const scopeFor = (purpose: import("@evoplug/budget").BudgetPurpose) => {
    const policy = loadBudgetPolicy(connection);
    if (!policy.ok) return policy;
    const scope = findScopePolicy(policy.value, purpose);
    if (scope === null) {
      return {
        ok: false as const,
        status: "rejected" as const,
        error: budgetError({ code: "E_BUDGET_POLICY_UNAVAILABLE", stage: "budget_scope_read", details: { kind: "none" } })
      };
    }
    return { ok: true as const, value: { policy: policy.value, scope } };
  };

  const insertReservation = (tx: Tx, row: Record<string, JsonValue>): void => {
    const params: Record<string, SqlValue> = {};
    for (const [key, value] of Object.entries(row)) {
      params[key] = sqlValue(value);
    }
    tx.prepare(
      `INSERT INTO budget_reservation (
         reservation_id, reservation_key, policy_version, task_id, branch_id, input_epoch,
         goal_version, config_version, watermark, purpose, scope_key, service_profile_id,
         service_profile_hash, state, attempt_allowance, input_token_allowance,
         output_token_allowance, cost_allowance_micros, cost_status, wall_allowance_ms,
         non_refundable, created_at, expires_at, settled_at
       ) VALUES (
         :reservation_id, :reservation_key, :policy_version, :task_id, :branch_id, :input_epoch,
         :goal_version, :config_version, :watermark, :purpose, :scope_key, :service_profile_id,
         :service_profile_hash, :state, :attempt_allowance, :input_token_allowance,
         :output_token_allowance, :cost_allowance_micros, :cost_status, :wall_allowance_ms,
         :non_refundable, :created_at, :expires_at, :settled_at
       )`
    ).run(params);
  };

  return {
    reserve: async (request) => {
      const scoped = scopeFor(request.purpose);
      if (!scoped.ok) return scoped;
      const current = now();
      const planned = planReservation({
        scope: scoped.value.scope,
        limits: request.limits,
        input_tokens_requested: request.input_tokens_requested,
        output_tokens_requested: request.output_tokens_requested,
        reservation_ttl_ms: scoped.value.policy.reservation_ttl_ms,
        now: current
      });
      if (!planned.ok) return planned;
      const existing = one<SqlRow>(
        connection,
        "SELECT reservation_id FROM budget_reservation WHERE scope_key = :scope_key AND reservation_key = :reservation_key",
        { scope_key: request.scope_key, reservation_key: request.reservation_key }
      );
      if (existing !== null) {
        const decoded = readReservationInTransaction(
          asTx(connection),
          stringField(existing, "reservation_id") as Id<"resv">
        );
        if (!decoded.ok) return decoded;
        return ok(decoded.value as unknown as import("@evoplug/review").BudgetReservationLike);
      }
      const unsettled = one<SqlRow>(
        connection,
        "SELECT 1 AS present FROM budget_reservation WHERE scope_key = :scope_key AND state = 'unsettled' LIMIT 1",
        { scope_key: request.scope_key }
      );
      if (unsettled !== null && request.limits.source === "verified_profile") {
        return {
          ok: false,
          status: "rejected",
          error: budgetError({
            code: "E_BUDGET_EXCEEDED",
            stage: "budget_reserve",
            details: {
              kind: "budget",
              scope_key: request.scope_key,
              policy_version: "bpol/1",
              budget_kind: "cost",
              remaining: null
            }
          })
        };
      }
      const reservation = createReservation({
        reservation_id: newId("resv", current),
        request: {
          schema_version: "rsi.budget_reserve/1",
          reservation_key: request.reservation_key,
          binding: request.binding,
          purpose: request.purpose,
          scope_key: request.scope_key,
          service_profile_id: request.service_profile_id,
          provider_scope: request.provider_scope,
          limits: request.limits,
          input_tokens_requested: request.input_tokens_requested,
          output_tokens_requested: request.output_tokens_requested,
          deadline_ms: request.deadline_ms
        },
        plan: planned.value,
        now: current
      });
      providerScopeByReservation.set(reservation.reservation_id, request.provider_scope);
      const profileHash = request.limits.source === "verified_profile"
        ? request.limits.profile_hash
        : canonicalHash({ source: "unknown", reason_code: request.limits.reason_code });
      const row = budgetReservationRow(reservation, scoped.value.scope, profileHash);
      row["scope_key"] = request.scope_key;
      row["service_profile_id"] = request.service_profile_id;
      const committed = await commitBudgetEvent({
        journal,
        now: current,
        event: {
          event_type: "budget.reserved",
          operation: "insert",
          binding: reservation.binding,
          reservation_id: reservation.reservation_id,
          row,
          before: null,
          apply: (tx) => insertReservation(tx, row)
        }
      });
      if (!committed.ok) return committed;
      return ok(reservation as unknown as import("@evoplug/review").BudgetReservationLike);
    },

    claim: async (request) =>
      serialize(async () => {
        const current = now();
        const reservationRow = one<SqlRow>(
          connection,
          "SELECT * FROM budget_reservation WHERE reservation_id = :reservation_id",
          { reservation_id: request.reservation_id }
        );
        if (reservationRow === null) {
          return {
            ok: false,
            status: "rejected",
            error: internalErrorEnvelope("kernel.budget_reservation_not_found")
          };
        }
        const reservationResult = readReservationInTransaction(asTx(connection), request.reservation_id);
        if (!reservationResult.ok) return reservationResult;
        const scoped = scopeFor(reservationResult.value.purpose);
        if (!scoped.ok) return scoped;
        const scopeKey = stringField(reservationRow, "scope_key");
        const inflight = one<SqlRow>(
          connection,
          "SELECT COUNT(*) AS count FROM budget_reservation WHERE scope_key = :scope_key AND state = 'claimed' AND expires_at > :now",
          { scope_key: scopeKey, now: current }
        );
        const globalInflight = one<SqlRow>(
          connection,
          "SELECT COUNT(*) AS count FROM budget_reservation WHERE state = 'claimed' AND expires_at > :now",
          { now: current }
        );
        const cooldown = one<SqlRow>(
          connection,
          "SELECT cooldown_until FROM rate_limit_state WHERE scope_key = :scope_key",
          { scope_key: scopeKey }
        );
        const claimRequest: BudgetClaimRequest = {
          reservation_id: request.reservation_id,
          attempt_ref: request.attempt_ref,
          input_tokens_estimated: request.input_tokens_estimated,
          output_tokens_reserved: request.output_tokens_reserved,
          counting_method_version: request.counting_method_version,
          deadline_ms: request.deadline_ms
        };
        const decision = planClaim({
          reservation: reservationResult.value,
          request: claimRequest,
          scope: scoped.value.scope,
          environment: {
            inflight: inflight === null ? 0 : numberField(inflight, "count"),
            per_scope_limit: scoped.value.policy.concurrency.per_scope_inflight,
            global_inflight: globalInflight === null ? 0 : numberField(globalInflight, "count"),
            global_limit: scoped.value.policy.concurrency.global_inflight,
            cooldown_until: cooldown === null ? null : nullableNumber(cooldown, "cooldown_until"),
            now: current
          },
          attempt_charge_id: newId("chg", current)
        });
        if (!decision.ok) return decision;
        if (decision.value.result.state === "blocked") {
          return ok(decision.value.result as unknown as import("@evoplug/review").BudgetClaimResultLike);
        }
        const providerScope = providerScopeByReservation.get(request.reservation_id) ?? scopeKey;
        const bucketConfig = {
          rpm: scoped.value.policy.concurrency.rpm,
          burst: scoped.value.policy.concurrency.burst
        };
        const bucket = tokenBuckets.get(providerScope) ?? { tokens: bucketConfig.burst, last_refill_ms: current };
        const consumed = consumeToken(bucket, bucketConfig, current);
        tokenBuckets.set(providerScope, consumed.state);
        if (!consumed.allowed) {
          return ok({
            state: "blocked" as const,
            reason_code: "rate_limited" as const,
            retry_after_ms: consumed.retry_after_ms
          });
        }
        const claimed = decision.value.reservation;
        const after = planReservationRowUpdate(claimed, reservationRow as unknown as Record<string, JsonValue>);
        const charge = makeClaimCharge({
          charge_id: decision.value.result.attempt_charge_id,
          charge_key: `claim:${claimed.reservation_id}:${request.attempt_ref}`,
          reservation_id: claimed.reservation_id,
          charged_at: current
        });
        const committed = await commitBudgetEvent({
          journal,
          now: current,
          event: {
            event_type: "budget.claimed",
            operation: "transition",
            binding: claimed.binding,
            reservation_id: claimed.reservation_id,
            row: after,
            before: reservationRow as unknown as Record<string, JsonValue>,
            apply: (tx) => {
              updateReservationRow(tx, claimed);
              insertAllowanceCharge(tx, charge);
            }
          }
        });
        if (!committed.ok) return committed;
        return ok(decision.value.result as unknown as import("@evoplug/review").BudgetClaimResultLike);
      }),

    settle: async (request) => {
      const current = now();
      const reservationRow = one<SqlRow>(
        connection,
        "SELECT * FROM budget_reservation WHERE reservation_id = :reservation_id",
        { reservation_id: request.reservation_id }
      );
      if (reservationRow === null) {
        return {
          ok: false,
          status: "rejected",
          error: internalErrorEnvelope("kernel.budget_reservation_not_found")
        };
      }
      const reservationResult = readReservationInTransaction(asTx(connection), request.reservation_id);
      if (!reservationResult.ok) return reservationResult;
      const scoped = scopeFor(reservationResult.value.purpose);
      if (!scoped.ok) return scoped;
      if (request.provider_usage !== null) {
        const usageCheck = validateProviderUsage(request.provider_usage);
        if (!usageCheck.ok) return usageCheck;
      }
      const settleRequest: BudgetSettleRequest = {
        reservation_id: request.reservation_id,
        outcome: request.outcome,
        provider_usage: request.provider_usage
      };
      const planned = planSettlement({
        reservation: reservationResult.value,
        request: settleRequest,
        scope: scoped.value.scope
      });
      if (!planned.ok) return planned;
      const settlement = planned.value.settlement;
      const next = planned.value.reservation;
      const after = planReservationRowUpdate(next, reservationRow as unknown as Record<string, JsonValue>);
      const usage = request.provider_usage;
      const committed = await commitBudgetEvent({
        journal,
        now: current,
        event: {
          event_type:
            settlement.state === "settled"
              ? "budget.settled"
              : settlement.state === "released"
                ? "budget.released"
                : "budget.unsettled",
          operation: "transition",
          binding: next.binding,
          reservation_id: next.reservation_id,
          row: after,
          before: reservationRow as unknown as Record<string, JsonValue>,
          apply: (tx) => {
            updateReservationRow(tx, next);
            if (usage !== null) {
              insertProviderUsage(tx, next.reservation_id, usage);
            }
            if (settlement.input_token_charges !== null) {
              insertAllowanceCharge(tx, makeUsageCharge({
                charge_id: newId("chg", current),
                charge_key: `usage:input:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "input_token",
                amount: settlement.input_token_charges,
                charged_at: current
              }));
            }
            if (settlement.output_token_charges !== null) {
              insertAllowanceCharge(tx, makeUsageCharge({
                charge_id: newId("chg", current),
                charge_key: `usage:output:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "output_token",
                amount: settlement.output_token_charges,
                charged_at: current
              }));
            }
            if (settlement.cost_charges_micros !== null) {
              insertAllowanceCharge(tx, makeUsageCharge({
                charge_id: newId("chg", current),
                charge_key: `usage:cost:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: "cost_micros",
                amount: settlement.cost_charges_micros,
                charged_at: current
              }));
            }
            if (planned.value.overage_charge !== null) {
              insertAllowanceCharge(tx, makeOverageCharge({
                charge_id: newId("chg", current),
                charge_key: `overage:${settlement.reservation_id}`,
                reservation_id: settlement.reservation_id,
                kind: planned.value.overage_charge.kind,
                amount: planned.value.overage_charge.amount,
                charged_at: current
              }));
            }
          }
        }
      });
      if (!committed.ok) return committed;
      return ok(settlement);
    }
  };
}

function internalErrorEnvelope(cause: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage: "internal",
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  });
}

/* ------------------------------------------------------------------ */
/* Generation input and attempt construction                           */
/* ------------------------------------------------------------------ */

function generationInputFailure(stage: string, cause: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  });
}

function evidenceKindFor(
  snapshot: ReviewSnapshot,
  ref: SourceRef
): "requirement" | "issue" | "correction" | "verification" | "artifact" | "outcome" {
  if (snapshot.requirements.some((entry) => entry.quote_ref === ref)) return "requirement";
  if (snapshot.issues.some((entry) => entry.question_ref === ref)) return "issue";
  if (snapshot.user_correction_refs.includes(ref)) return "correction";
  if (snapshot.verification_refs.includes(ref)) return "verification";
  if (snapshot.artifacts.some((entry) => entry.source_ref === ref)) return "artifact";
  if (snapshot.outcome_ref === ref) return "outcome";
  return "artifact";
}

function refByteLength(ref: SourceRef): number | null {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) return null;
  return parsed.value.end - parsed.value.start;
}

/**
 * Builds `rsi.generator_input/1` from the snapshot and the claim quota.
 * The manifest carries only egress-approved evidence and experience refs in
 * snapshot order; every hash comes from the V9b/V13 source bindings.
 */
export function buildGeneratorInputValue(input: {
  connection: SqliteConnection;
  config: EvoplugConfig;
  blobStore: BlobStore;
  job: ReviewJob;
  attemptId: Id<"rat">;
  snapshot: ReviewSnapshot;
  quota: { input_tokens_estimated: number; output_tokens_reserved: number; deadline_ms: number };
}): Result<GeneratorInput, ErrorEnvelope> {
  const { snapshot, blobStore } = input;
  const bindings = new Map<SourceRef, ReviewSnapshot["source_bindings"][number]>();
  for (const binding of snapshot.source_bindings) {
    bindings.set(binding.ref, binding);
  }
  const approvedEvidence = new Set(snapshot.coverage.egress_approved_refs);
  const approvedExperience = new Set(snapshot.coverage.egress_approved_experience_refs);

  const evidence: GeneratorInput["evidence"] = [];
  for (const ref of snapshot.evidence_refs) {
    if (!approvedEvidence.has(ref)) continue;
    const binding = bindings.get(ref);
    const parsed = parseSourceRef(ref);
    let contentHash = binding?.range_content_hash ?? binding?.content_version ?? null;
    if (contentHash === null && parsed.ok && parsed.value.scheme === "blob") {
      const stored = blobStore.read(parsed.value.locator as Hash);
      if (stored.ok) {
        contentHash = hashBytes(
          stored.value.subarray(parsed.value.start, parsed.value.end)
        );
      }
    }
    if (contentHash === null) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_SOURCE_HASH",
          category: "source",
          message_key: "error.source_hash",
          stage: "source_metadata",
          retryable: false,
          side_effect: "none",
          details: { kind: "source", source_ref: ref, reason: "missing" }
        })
      };
    }
    const bytes = refByteLength(ref);
    if (bytes === null || bytes < 1) {
      return {
        ok: false,
        status: "rejected",
        error: generationInputFailure("generate", "evidence_range")
      };
    }
    const kind = evidenceKindFor(snapshot, ref);
    evidence.push({
      evidence_id: `ev-${String(evidence.length + 1).padStart(3, "0")}`,
      kind,
      source_ref: ref,
      content_hash: contentHash,
      path: `input/evidence/${String(evidence.length + 1).padStart(3, "0")}`,
      bytes
    });
  }

  const existing: GeneratorInput["existing_experiences"] = [];
  for (const candidate of snapshot.experience_candidates) {
    if (!approvedExperience.has(candidate.source_ref)) continue;
    existing.push({
      experience_ref: candidate.source_ref,
      experience_id: candidate.experience_id,
      version: candidate.version,
      content_hash: candidate.content_hash,
      path: `input/experiences/${String(existing.length + 1).padStart(3, "0")}`
    });
  }

  const taskRow = one<SqlRow>(
    input.connection,
    "SELECT project_id FROM task WHERE task_id = :task_id",
    { task_id: input.job.task_id }
  );
  const projectId = taskRow === null ? null : nullableString(taskRow, "project_id");
  const roots = input.config.projects.roots
    .filter((root) => projectId === null || root.project_id === projectId)
    .map((root) => root.root);

  return ok({
    schema_version: "rsi.generator_input/1",
    job_id: input.job.job_id,
    attempt_id: input.attemptId,
    snapshot_id: snapshot.snapshot_id,
    snapshot_hash: snapshot.snapshot_hash,
    protocol_version: "rsi.generator_protocol/1",
    instructions_version: "instructions/1",
    output_schema_version: "rsi.generator_output/1",
    budget: {
      input_tokens_estimated: input.quota.input_tokens_estimated,
      output_tokens_reserved: input.quota.output_tokens_reserved,
      max_wall_ms: snapshot.budget.wall_ms,
      deadline_at: input.quota.deadline_ms,
      max_proposals: snapshot.output_policy.max_proposals,
      output_policy_hash: snapshot.output_policy.output_policy_hash
    },
    evidence,
    existing_experiences: existing,
    target_policy: {
      allowed_object_types: ["skill", "memory", "instructions"],
      allowed_target_refs: roots,
      protected_fields: []
    },
    data_policy_ref: "data-policy:default"
  });
}

function materializeJsonBlob(
  blobStore: BlobStore,
  value: JsonValue
): Result<{ ref: SourceRef; bytes: Uint8Array }, ErrorEnvelope> {
  const bytes = canonicalJson(value);
  const stored = blobStore.putSync(bytes);
  if (!stored.ok) return stored;
  return ok({ ref: blobRef(hashBytes(bytes), bytes.byteLength), bytes });
}

function projectRootFor(
  connection: SqliteConnection,
  config: EvoplugConfig,
  taskId: Id<"task">
): string | null {
  const taskRow = one<SqlRow>(connection, "SELECT project_id FROM task WHERE task_id = :task_id", {
    task_id: taskId
  });
  const projectId = taskRow === null ? null : nullableString(taskRow, "project_id");
  const matches = config.projects.roots.filter(
    (root) => projectId !== null && root.project_id === projectId
  );
  if (matches.length === 1) return matches[0]?.root ?? null;
  if (projectId === null && config.projects.roots.length === 1) {
    return config.projects.roots[0]?.root ?? null;
  }
  return null;
}

export function buildAttemptEnvironment(input: {
  connection: SqliteConnection;
  config: EvoplugConfig;
  blobStore: BlobStore;
  home: string;
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  backend: Extract<import("@evoplug/review").GenerationBackendSelection, { state: "available" }>;
  quota: { input_tokens_estimated: number; output_tokens_reserved: number; deadline_ms: number };
  attempt_id: Id<"rat">;
}): Result<{
  backend: ReviewAttempt["backend"];
  model_id: string;
  host_run: ReviewAttempt["host_run"];
  isolation: ReviewAttempt["isolation"];
  input_manifest_ref: SourceRef;
  input_manifest_hash: Hash;
  output_ref: SourceRef;
}, ErrorEnvelope> {
  const { job, snapshot, backend, quota, attempt_id, blobStore } = input;
  const generatorInput = buildGeneratorInputValue({
    connection: input.connection,
    config: input.config,
    blobStore,
    job,
    attemptId: attempt_id,
    snapshot,
    quota
  });
  if (!generatorInput.ok) return generatorInput;
  const manifestBytes = canonicalJson(toJsonValue(generatorInput.value));
  const stored = blobStore.putSync(manifestBytes);
  if (!stored.ok) return stored;
  const inputManifestRef = blobRef(hashBytes(manifestBytes), manifestBytes.byteLength);
  const inputManifestHash = generatorInputManifestHash(generatorInput.value);

  const workspaceRef = projectRootFor(input.connection, input.config, job.task_id) ?? input.home;
  const isolationValue = {
    schema_version: "rsi.generation_isolation/1",
    backend_id: backend.backend.backend_id,
    backend_version: backend.backend.backend_version,
    isolation: backend.backend.isolation,
    service_profile_hash: backend.service_profile.service_profile_key,
    selected_at: Math.max(0, Math.floor(quota.deadline_ms - snapshot.budget.wall_ms))
  };
  const workspaceProbe = materializeJsonBlob(blobStore, toJsonValue({
    schema_version: "rsi.workspace_probe/1",
    workspace_ref: workspaceRef,
    mode: backend.backend.isolation.mode,
    exists: true
  }));
  if (!workspaceProbe.ok) return workspaceProbe;
  const networkDecision = materializeJsonBlob(blobStore, toJsonValue({
    schema_version: "rsi.network_decision/1",
    backend_id: backend.backend.backend_id,
    network: backend.backend.isolation.network,
    required: "disabled"
  }));
  if (!networkDecision.ok) return networkDecision;
  const isolationEvidence = materializeJsonBlob(blobStore, toJsonValue(isolationValue));
  if (!isolationEvidence.ok) return isolationEvidence;

  const pendingBytes = new TextEncoder().encode(`rsi.review_output_pending/${attempt_id}`);
  const pendingHash = hashBytes(pendingBytes);
  const outputRef = blobRef(pendingHash, pendingBytes.byteLength);

  return ok({
    backend: backend.backend,
    model_id: backend.backend.backend_id,
    host_run: {
      generation_run_id: `${attempt_id}:run`,
      backend_selection_ref: backendSelectionRef(backend)
    },
    isolation: {
      workspace_ref: workspaceRef,
      workspace_mode: backend.backend.isolation.mode === "none" ? "none" : "isolated",
      workspace_probe_ref: workspaceProbe.value.ref,
      environment_hash: canonicalHash(toJsonValue(isolationValue)),
      network_decision_ref: networkDecision.value.ref,
      isolation_evidence_ref: isolationEvidence.value.ref
    },
    input_manifest_ref: inputManifestRef,
    input_manifest_hash: inputManifestHash,
    output_ref: outputRef
  });
}

/* ------------------------------------------------------------------ */
/* REV commit ports (T3-T6)                                            */
/* ------------------------------------------------------------------ */

function proposalStaticError(code: `E_${string}`, path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: "schema",
    message_key: "error.schema",
    stage: "proposal_static_check",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/** Collects the `SourceRef` strings reachable from a physical row. */
function rowSourceRefs(value: JsonValue): SourceRef[] {
  const refs = new Set<SourceRef>();
  const visit = (entry: JsonValue): void => {
    if (typeof entry === "string") {
      if (entry.startsWith("blob://") || entry.startsWith("journal://")) {
        refs.add(entry as SourceRef);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (typeof entry === "object" && entry !== null) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return [...refs].sort();
}

function rowSourceHashes(value: JsonValue): Hash[] {
  const out: Hash[] = [];
  for (const ref of rowSourceRefs(value)) {
    const parsed = parseSourceRef(ref);
    if (parsed.ok && parsed.value.scheme === "blob") {
      out.push(parsed.value.locator as Hash);
    }
  }
  return out;
}

function stateMember(input: {
  row_schema: string;
  object_key: string;
  operation: "insert" | "update" | "transition";
  row: Record<string, JsonValue>;
  before: Record<string, JsonValue> | null;
  binding: VersionBinding | null;
  expected?: Readonly<Record<string, SqlValue>>;
}): CommitMember {
  const table = TABLE_BY_SCHEMA[input.row_schema];
  if (table === undefined) {
    throw new Error(`unregistered review row schema: ${input.row_schema}`);
  }
  const row = Object.fromEntries(
    Object.entries(input.row).map(([key, entry]) => [key, entry === undefined ? null : entry])
  ) as Record<string, JsonValue>;
  return {
    row_schema: input.row_schema,
    object_key: input.object_key,
    operation: input.operation,
    row,
    before:
      input.before === null
        ? null
        : (Object.fromEntries(
            Object.entries(input.before).map(([key, entry]) => [
              key,
              entry === undefined ? null : entry
            ])
          ) as Record<string, JsonValue>),
    binding: input.binding,
    table: table.table,
    primary_key: table.primary_key,
    expected: input.expected ?? {},
    blob_hashes: rowSourceHashes(toJsonValue(row))
  };
}

function stagedReviewBlob(
  blobStore: BlobStore,
  bytes: Uint8Array,
  ownerId: string
): Result<StagedBlob, ErrorEnvelope> {
  const stored = blobStore.putSync(bytes);
  if (!stored.ok) return stored;
  return ok({
    bytes,
    ref: blobRef(stored.value.hash, bytes.byteLength),
    owner_type: "review",
    owner_id: ownerId
  });
}

/**
 * T3: parse and validate the completed output, then commit the acceptance
 * point, attempt after-image, job after-image and pending candidates as one
 * journal frame and one SQLite transaction.
 */
export function createReviewAcceptanceCommit(input: {
  connection: SqliteConnection;
  blobStore: BlobStore;
  journal: ReviewJournal | null;
  now: () => number;
}): ReviewServiceDeps["acceptanceCommit"] {
  return async (commit) => {
    const { attempt, job, snapshot, output_bytes: outputBytes, now } = commit;
    const blobStore = input.blobStore;
    const existingAcceptance = one<SqlRow>(
      input.connection,
      "SELECT * FROM review_output_acceptances WHERE attempt_id = :id",
      { id: attempt.attempt_id }
    );
    if (existingAcceptance !== null) {
      const jobRow = one<SqlRow>(
        input.connection,
        "SELECT * FROM review_jobs WHERE job_id = :id",
        { id: job.job_id }
      );
      const attemptRow = one<SqlRow>(
        input.connection,
        "SELECT * FROM review_attempts WHERE attempt_id = :id",
        { id: attempt.attempt_id }
      );
      if (jobRow !== null && attemptRow !== null) {
        return ok({
          job: jobFromRow(jobRow),
          attempt: attemptFromRow(attemptRow),
          candidates: all<SqlRow>(
            input.connection,
            "SELECT * FROM proposal_candidates WHERE attempt_id = :id ORDER BY ordinal",
            { id: attempt.attempt_id }
          ).map(candidateFromRow)
        });
      }
    }
    const parsed = parseGeneratorOutput(
      outputBytes,
      {
        max_proposals: snapshot.output_policy.max_proposals,
        max_progress_events: snapshot.output_policy.max_progress_events,
        max_output_bytes: snapshot.output_policy.max_output_bytes,
        max_output_line_bytes: snapshot.output_policy.max_output_line_bytes,
        max_output_lines: snapshot.output_policy.max_output_lines
      },
      attempt.attempt_id
    );
    if (!parsed.ok) return parsed;
    if (attempt.output !== undefined && attempt.output.hash !== parsed.value.hash) {
      return {
        ok: false,
        status: "rejected",
        error: makeErrorEnvelope({
          code: "E_REVIEW_OUTPUT_READ_MISMATCH",
          category: "source",
          message_key: "error.review_output_read_mismatch",
          stage: "accept_output",
          retryable: false,
          side_effect: "none",
          details: {
            kind: "source_conflict",
            source_ref: attempt.output_ref,
            expected: attempt.output.hash,
            actual: parsed.value.hash
          }
        })
      };
    }
    const outputRef = blobRef(parsed.value.hash, outputBytes.byteLength);
    const outputBlob = await blobStore.put(outputBytes);
    if (!outputBlob.ok) return outputBlob;

    const versionBinding = snapshot.version_binding;
    const generator = {
      backend_id: attempt.backend.backend_id,
      model_id: attempt.model_id,
      protocol_version: "rsi.generator_protocol/1" as const,
      generator_version: attempt.backend.backend_version
    };
    const records: ProposalCandidateRecord[] = [];
    const blobs: StagedBlob[] = [];
    for (const entry of parsed.value.proposals) {
      const candidateBytes = canonicalJson(entry.proposal);
      const stored = blobStore.putSync(candidateBytes);
      if (!stored.ok) return stored;
      const candidateRef = blobRef(stored.value.hash, candidateBytes.byteLength);
      const candidateJsonHash = stored.value.hash;
      const candidateKey = candidateKeyFrom({
        job_id: job.job_id,
        attempt_id: attempt.attempt_id,
        ordinal: entry.ordinal,
        output_hash: parsed.value.hash,
        candidate_json_hash: candidateJsonHash
      });
      records.push({
        schema_version: "rsi.proposal_candidate_record/1",
        candidate_key: candidateKey,
        job_id: job.job_id,
        attempt_id: attempt.attempt_id,
        ordinal: entry.ordinal,
        version_binding: versionBinding,
        output_ref: outputRef,
        output_hash: parsed.value.hash,
        candidate_ref: candidateRef,
        candidate_json_hash: candidateJsonHash,
        generator,
        state: "pending",
        failure: null,
        proposal_id: null,
        proposal_hash: null,
        experience_id: null,
        experience_version: null,
        accepted_bundle_ref: null,
        row_version: 1,
        created_at: now,
        checked_at: null
      });
      blobs.push({
        bytes: candidateBytes,
        ref: candidateRef,
        owner_type: "review",
        owner_id: candidateKey
      });
    }
    const acceptance = acceptanceRowFromParts({
      attempt,
      job,
      output_ref: outputRef,
      output_hash: parsed.value.hash,
      candidate_count: records.length,
      accepted_at: now
    });
    const nextAttempt: ReviewAttempt = {
      ...attempt,
      state: "succeeded",
      output: {
        ref: outputRef,
        hash: parsed.value.hash,
        bytes: parsed.value.bytes,
        lines: parsed.value.lines,
        proposal_count: records.length,
        schema_valid: true,
        ...(attempt.output?.read_cursor === undefined
          ? {}
          : { read_cursor: attempt.output.read_cursor }),
        accepted_at: now
      },
      row_version: attempt.row_version + 1,
      updated_at: now
    };
    const nextJob: ReviewJob = {
      ...job,
      state: "generating",
      stage: "static_check",
      active_attempt_id: attempt.attempt_id,
      version: job.version + 1,
      updated_at: now
    };
    const members: CommitMember[] = [
      stateMember({
        row_schema: "rsi.review_output_acceptance_row/1",
        object_key: attempt.attempt_id,
        operation: "insert",
        row: acceptance as unknown as Record<string, JsonValue>,
        before: null,
        binding: versionBinding
      }),
      stateMember({
        row_schema: "rsi.review_attempt/1",
        object_key: attempt.attempt_id,
        operation: "transition",
        row: attemptRowFromAttempt(nextAttempt) as unknown as Record<string, JsonValue>,
        before: attemptRowFromAttempt(attempt) as unknown as Record<string, JsonValue>,
        binding: versionBinding,
        expected: { attempt_id: attempt.attempt_id, row_version: attempt.row_version }
      }),
      stateMember({
        row_schema: "rsi.review_job/2",
        object_key: job.job_id,
        operation: "transition",
        row: jobRowFromJob(nextJob) as unknown as Record<string, JsonValue>,
        before: jobRowFromJob(job) as unknown as Record<string, JsonValue>,
        binding: versionBinding,
        expected: { job_id: job.job_id, version: job.version }
      })
    ];
    for (const record of records) {
      members.push(
        stateMember({
          row_schema: "rsi.proposal_candidate_row/1",
          object_key: record.candidate_key,
          operation: "insert",
          row: candidateRowFromRecord(record) as unknown as Record<string, JsonValue>,
          before: null,
          binding: versionBinding
        })
      );
    }
    const committed = await commitReviewMembers({
      journal: input.journal,
      connection: input.connection,
      blobStore: input.blobStore,
      members,
      blobs: [
        { bytes: outputBytes, ref: outputRef, owner_type: "review", owner_id: attempt.attempt_id },
        ...blobs
      ],
      now
    });
    if (!committed.ok) return committed;
    return ok({ job: nextJob, attempt: nextAttempt, candidates: records });
  };
}

/** Static-check context backed by the live target, blob store and FND facts. */
export function createKernelStaticCheckContext(input: {
  connection: SqliteConnection;
  config: EvoplugConfig;
  blobStore: BlobStore;
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  attempt: ReviewAttempt;
  now: number;
  staged: Map<SourceRef, Uint8Array>;
}): StaticCheckContext {
  const { connection, config, blobStore, job, snapshot, attempt, now, staged } = input;
  const binding = snapshot.host_event.binding;

  const readAbsolute = (target: ResolvedTarget): Result<Uint8Array, ErrorEnvelope> => {
    if (!existsSync(target.approved_root)) {
      return ok(new Uint8Array(0));
    }
    const absolute = resolve(target.approved_root, target.path_or_block);
    if (!existsSync(absolute)) {
      return ok(new Uint8Array(0));
    }
    try {
      return ok(readFileSync(absolute));
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "unreadable")
      };
    }
  };

  const resolveTarget = (target: ProposalCandidate["target"]): Result<ResolvedTarget, ErrorEnvelope> => {
    if (target.host_id !== binding.host_id) {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.host_id", "snapshot_host")
      };
    }
    const matches = config.projects.roots.filter(
      (root) => target.project_id !== undefined && root.project_id === target.project_id
    );
    const fallback =
      target.project_id === undefined && config.projects.roots.length === 1
        ? config.projects.roots
        : [];
    const root = (matches.length === 1 ? matches[0] : fallback[0]) ?? null;
    if (root === null) {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.project_id", "root_not_registered")
      };
    }
    let approvedRoot: string;
    try {
      const stats = statSync(root.root);
      if (!stats.isDirectory()) {
        return {
          ok: false,
          status: "rejected",
          error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "root_not_directory")
        };
      }
      approvedRoot = realpathSync(root.root);
    } catch {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "root_unavailable")
      };
    }
    if (
      target.path_or_block.length === 0 ||
      isAbsolute(target.path_or_block) ||
      target.path_or_block.split("/").includes("..")
    ) {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "outside_approved_root")
      };
    }
    const absolute = resolve(approvedRoot, target.path_or_block);
    if (!within(approvedRoot, absolute)) {
      return {
        ok: false,
        status: "rejected",
        error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "outside_approved_root")
      };
    }
    let exists = false;
    try {
      exists = statSync(absolute).isFile();
      if (exists) {
        const real = realpathSync(absolute);
        if (!within(approvedRoot, real)) {
          return {
            ok: false,
            status: "rejected",
            error: proposalStaticError("E_PROPOSAL_TARGET", "target.path_or_block", "symlink_escape")
          };
        }
      }
    } catch {
      exists = false;
    }
    const writeMode = target.requested_write_mode;
    const resolution = {
      schema_version: "rsi.target_binding/1",
      target_ref: target.target_ref,
      host_id: target.host_id,
      project_id: target.project_id ?? root.project_id,
      approved_root: approvedRoot,
      path_or_block: target.path_or_block,
      block_id: target.block_id ?? null,
      write_mode: writeMode,
      block_selector: writeMode === "managed_block" ? target.block_id ?? null : null,
      ownership: writeMode === "managed_block" || !exists ? "rsi_managed" : "shared_handwritten",
      exists,
      resolved_at: now
    };
    const materialized = materializeTargetBlob(blobStore, staged, toJsonValue(resolution));
    if (!materialized.ok) return materialized;
    return ok({
      target_ref: target.target_ref,
      host_id: target.host_id,
      project_id: target.project_id ?? root.project_id,
      object_type: targetObjectType(target.target_ref),
      config_space: binding.config_space,
      mode: binding.mode,
      path_or_block: target.path_or_block,
      ...(target.block_id === undefined ? {} : { block_id: target.block_id }),
      ownership: resolution.ownership as ResolvedTarget["ownership"],
      write_mode: writeMode,
      block_selector: resolution.block_selector,
      approved_root: approvedRoot,
      target_binding_ref: materialized.value,
      exists
    });
  };

  const scopes = new Map<string, ResolvedTarget>();
  return {
    snapshot,
    resolveTarget: (target) => {
      const resolved = resolveTarget(target);
      if (resolved.ok) scopes.set(resolved.value.target_ref, resolved.value);
      return resolved;
    },
    readBase: (target) => readAbsolute(target),
    readCurrentFile: (target) => readAbsolute(target),
    currentTargetHashes: (target) => {
      const current = readAbsolute(target);
      if (!current.ok) return current;
      const blockHash =
        target.write_mode === "managed_block" && target.block_selector !== null
          ? extractManagedBlockHash(current.value, target.block_selector)
          : ok(null);
      if (!blockHash.ok) return blockHash;
      return ok({ file_hash: hashBytes(current.value), block_hash: blockHash.value });
    },
    extractBlock: (file, selector) => extractManagedBlock(file, selector),
    rebuildFile: (file, selector, block) => {
      const edited = applyManagedBlockEdit({
        bytes: file,
        selector,
        block_action: "update",
        content: new TextEncoder().encode(block)
      });
      if (!edited.ok) return edited;
      return ok(edited.value.bytes);
    },
    readSource: (ref) => {
      const read = readSourceRef(connection, blobStore, ref);
      if (read.ok) staged.set(ref, read.value.bytes);
      return read.ok ? ok(read.value.bytes) : read;
    },
    materializeBlob: (bytes) => {
      const stored = blobStore.putSync(bytes);
      if (!stored.ok) return stored;
      const ref = blobRef(stored.value.hash, bytes.byteLength);
      staged.set(ref, bytes);
      return ok(ref);
    },
    resolveVerifier: (ref) => resolveFactVerifier(connection, ref),
    refinable: (ref) => refinableExperience(connection, ref),
    allocate: (allocation) => {
      const version =
        allocation.existing_versions.length === 0
          ? 1
          : Math.max(...allocation.existing_versions) + 1;
      return ok({
        experience_id: allocation.experience_id ?? newId("exp", now),
        version,
        validation_plan_id: newId("plan", now),
        proposal_id: newId("prop", now)
      });
    },
    normalize: (normalization) => {
      const target = normalization.target;
      const scope = deriveExperienceScope({
        snapshot,
        targetHostId: target.host_id,
        projectId: target.project_id ?? null,
        attemptEnvironmentFingerprints: [attempt.isolation.environment_hash],
        attemptToolVersionRanges: [],
        attemptModelFamilies: attempt.model_id.length === 0 ? [] : [attempt.model_id],
        allowGlobal: false
      });
      const risk = normalizeRisk({
        type: normalization.candidate.experience.type,
        ownership: target.ownership,
        counterexampleCount: normalization.candidate.experience.counterexamples.length,
        policyFloor: "low",
        ...(normalization.refines === null
          ? {}
          : { restoreFrom: normalization.refines.experience.risk })
      });
      const riskPolicy = materializeTargetBlob(
        blobStore,
        staged,
        toJsonValue({
          schema_version: "rsi.risk_policy/1",
          policy_id: "risk/default",
          floor: "low",
          normalized_at: now
        })
      );
      if (!riskPolicy.ok) return riskPolicy;
      const scopeSource = materializeTargetBlob(
        blobStore,
        staged,
        toJsonValue({
          schema_version: "rsi.scope_source/1",
          target_ref: target.target_ref,
          host_id: target.host_id,
          project_id: target.project_id ?? null,
          mode: binding.mode,
          snapshot_id: snapshot.snapshot_id,
          eligible: true
        })
      );
      if (!scopeSource.ok) return scopeSource;
      return ok({
        scope,
        risk,
        risk_policy_ref: riskPolicy.value,
        scope_source_ref: scopeSource.value,
        template_hash: experienceMatchTemplateHash(),
        generator: {
          backend_id: attempt.backend.backend_id,
          model_id: attempt.model_id,
          protocol_version: "rsi.generator_protocol/1",
          generator_version: attempt.backend.backend_version
        }
      });
    },
    checkScope: ({ target, normalizedScope }) => {
      if (normalizedScope.level === "project") {
        if (target.project_id === undefined || !normalizedScope.project_ids.includes(target.project_id)) {
          return {
            ok: false,
            status: "rejected",
            error: proposalStaticError("E_PROPOSAL_SCOPE", "scope.project_ids", "target_project")
          };
        }
      }
      if (normalizedScope.level === "host" || normalizedScope.level === "project") {
        if (!normalizedScope.host_ids.includes(target.host_id)) {
          return {
            ok: false,
            status: "rejected",
            error: proposalStaticError("E_PROPOSAL_SCOPE", "scope.host_ids", "target_host")
          };
        }
        if (normalizedScope.modes.length > 0 && !normalizedScope.modes.includes(binding.mode)) {
          return {
            ok: false,
            status: "rejected",
            error: proposalStaticError("E_PROPOSAL_SCOPE", "scope.modes", "snapshot_mode")
          };
        }
      }
      return ok(undefined);
    },
    approvedEvidenceRefs: new Set(snapshot.coverage.egress_approved_refs),
    snapshotEvidenceRefs: new Set(snapshot.evidence_refs),
    approvedExperienceRefs: new Set(snapshot.coverage.egress_approved_experience_refs),
    retrievable: (ref) => readSourceRef(connection, blobStore, ref).ok,
    allowedObjectTypes: new Set(["skill", "memory", "instructions"]),
    allowedTargetRefs: new Set(),
    protectedFields: new Set(),
    now,
    ...(job === undefined ? {} : {})
  };
}

function within(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function targetObjectType(targetRef: string): ResolvedTarget["object_type"] {
  if (targetRef.startsWith("skill:")) return "skill";
  if (targetRef.startsWith("memory:")) return "memory";
  return "instructions";
}

function materializeTargetBlob(
  blobStore: BlobStore,
  staged: Map<SourceRef, Uint8Array>,
  value: JsonValue
): Result<SourceRef, ErrorEnvelope> {
  const bytes = canonicalJson(value);
  const stored = blobStore.putSync(bytes);
  if (!stored.ok) return stored;
  const ref = blobRef(stored.value.hash, bytes.byteLength);
  staged.set(ref, bytes);
  return ok(ref);
}

function extractManagedBlock(file: Uint8Array, selector: string): Result<string, ErrorEnvelope> {
  const parsed = parseManagedBlocks(file);
  if (!parsed.ok) return parsed;
  const block = parsed.value.blocks.find((entry) => entry.selector === selector);
  if (block === undefined) {
    return {
      ok: false,
      status: "rejected",
      error: proposalStaticError("E_PROPOSAL_OLD_HASH_MISMATCH", "target.block_selector", "block_missing")
    };
  }
  const content = file.subarray(block.content_start, block.end_start);
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return {
      ok: false,
      status: "rejected",
      error: proposalStaticError("E_PROPOSAL_OLD_HASH_MISMATCH", "target.block_selector", "block_not_utf8")
    };
  }
}

function extractManagedBlockHash(
  file: Uint8Array,
  selector: string
): Result<Hash, ErrorEnvelope> {
  const parsed = parseManagedBlocks(file);
  if (!parsed.ok) return parsed;
  const block = parsed.value.blocks.find((entry) => entry.selector === selector);
  if (block === undefined) {
    return {
      ok: false,
      status: "rejected",
      error: proposalStaticError("E_PROPOSAL_STALE_TARGET", "target.block_selector", "block_missing")
    };
  }
  return ok(block.block_hash);
}

function resolveFactVerifier(
  connection: SqliteConnection,
  ref: SourceRef
): Result<import("@evoplug/review").VerifierRegistryEntry, ErrorEnvelope> {
  const row = one<SqlRow>(
    connection,
    `SELECT fv.verifier_kind, fv.independent, fv.status, fv.result, fv.effect,
            sf.stale
       FROM fact_verification fv
       LEFT JOIN state_fact sf ON sf.fact_id = fv.fact_id
      WHERE fv.verifier_ref = :ref
      ORDER BY fv.verified_at DESC
      LIMIT 1`,
    { ref }
  );
  if (row === null) {
    return {
      ok: false,
      status: "rejected",
      error: proposalStaticError("E_EXPERIENCE_VERIFIER_BINDING", "validation_plan.verifier.verifier_ref", "not_registered")
    };
  }
  if (
    stringField(row, "status") !== "valid" ||
    stringField(row, "result") !== "verified" ||
    stringField(row, "effect") !== "supports" ||
    (row["stale"] !== null && row["stale"] !== undefined && numberField(row, "stale") === 1)
  ) {
    return {
      ok: false,
      status: "rejected",
      error: proposalStaticError("E_EXPERIENCE_VERIFIER_BINDING", "validation_plan.verifier.verifier_ref", "not_valid")
    };
  }
  const kind = stringField(row, "verifier_kind");
  const mappedKind =
    kind === "test"
      ? "test_pass"
      : kind === "artifact_check"
        ? "artifact_check"
        : kind === "external"
          ? "external_verification"
          : kind === "human"
            ? "human_acceptance"
            : "none";
  const independent = row["independent"] !== null && numberField(row, "independent") === 1;
  return ok({
    binding_ref: ref,
    kind: mappedKind,
    independence: independent ? "independent" : mappedKind === "human_acceptance" ? "user_confirmation" : "same_task_replay"
  });
}

function refinableExperience(connection: SqliteConnection, ref: SourceRef): import("@evoplug/review").RefineSource | null {
  const row = one<SqlRow>(
    connection,
    `SELECT * FROM experiences
      WHERE body_ref = :ref AND superseded_by_version IS NULL
      ORDER BY version DESC
      LIMIT 1`,
    { ref }
  );
  if (row === null) return null;
  const plan = one<SqlRow>(
    connection,
    "SELECT * FROM validation_plans WHERE validation_plan_id = :id",
    { id: stringField(row, "validation_plan_id") }
  );
  if (plan === null) return null;
  return { experience: experienceFromRow(row, null), validation_plan: validationPlanFromRow(plan) };
}

/**
 * T4: commit candidate transitions and accepted Proposal/Experience/Plan rows,
 * then commit the job after-image in a separate frame.
 */
export function createReviewStaticCheckCommit(input: {
  connection: SqliteConnection;
  blobStore: BlobStore;
  journal: ReviewJournal | null;
  now: () => number;
  staged: Map<SourceRef, Uint8Array>;
}): ReviewServiceDeps["staticCheckCommit"] {
  return async (commit) => {
    const { job, snapshot, candidates, checked, now } = commit;
    const binding = snapshot.version_binding;
    const byKey = new Map(candidates.map((candidate) => [candidate.candidate_key, candidate]));
    const members: CommitMember[] = [];
    const blobs: StagedBlob[] = [];
    const proposals: Proposal[] = [];
    const nowCandidates: ProposalCandidateRecord[] = [];
    for (const entry of checked) {
      const current = byKey.get(entry.candidate_key);
      if (current === undefined) {
        return {
          ok: false,
          status: "rejected",
          error: storageUnavailable("review_candidate_missing")
        };
      }
      if (current.state !== "pending") {
        nowCandidates.push(current);
        continue;
      }
      const before = candidateRowFromRecord(current) as unknown as Record<string, JsonValue>;
      if (entry.failure !== undefined) {
        const stale = entry.failure.code === "E_PROPOSAL_STALE_TARGET";
        const next: ProposalCandidateRecord = {
          ...current,
          state: stale ? "stale" : "rejected",
          failure: {
            code: entry.failure.code as NonNullable<ProposalCandidateRecord["failure"]>["code"],
            step: entry.failure.step as NonNullable<ProposalCandidateRecord["failure"]>["step"],
            detail_ref: entry.failure.detail_ref
          },
          proposal_id: null,
          proposal_hash: null,
          experience_id: null,
          experience_version: null,
          accepted_bundle_ref: null,
          row_version: 2,
          checked_at: now
        };
        nowCandidates.push(next);
        members.push(
          stateMember({
            row_schema: "rsi.proposal_candidate_row/1",
            object_key: current.candidate_key,
            operation: "transition",
            row: candidateRowFromRecord(next) as unknown as Record<string, JsonValue>,
            before,
            binding,
            expected: { candidate_key: current.candidate_key, row_version: 1 }
          })
        );
        continue;
      }
      if (entry.proposal === undefined || entry.experience === undefined || entry.validation_plan === undefined) {
        return {
          ok: false,
          status: "rejected",
          error: storageUnavailable("review_acceptance_bundle_missing")
        };
      }
      const proposal = entry.proposal;
      const experience = entry.experience;
      const plan = entry.validation_plan;
      const bundleBytes = canonicalJson(
        toJsonValue({
          schema_version: "rsi.proposal_acceptance_bundle/1",
          candidate_key: current.candidate_key,
          proposal,
          experience,
          validation_plan: plan
        })
      );
      const bundleStored = input.blobStore.putSync(bundleBytes);
      if (!bundleStored.ok) return bundleStored;
      const bundleRef = blobRef(bundleStored.value.hash, bundleBytes.byteLength);
      blobs.push({
        bytes: bundleBytes,
        ref: bundleRef,
        owner_type: "review",
        owner_id: current.candidate_key
      });
      const accepted: ProposalCandidateRecord = {
        ...current,
        state: "accepted",
        failure: null,
        proposal_id: proposal.proposal_id as Id<"prop">,
        proposal_hash: proposal.proposal_hash,
        experience_id: experience.experience_id as Id<"exp">,
        experience_version: experience.version,
        accepted_bundle_ref: bundleRef,
        row_version: 2,
        checked_at: now
      };
      nowCandidates.push(accepted);
      proposals.push(proposal);
      members.push(
        stateMember({
          row_schema: "rsi.proposal_candidate_row/1",
          object_key: current.candidate_key,
          operation: "transition",
          row: candidateRowFromRecord(accepted) as unknown as Record<string, JsonValue>,
          before,
          binding,
          expected: { candidate_key: current.candidate_key, row_version: 1 }
        }),
        stateMember({
          row_schema: "rsi.proposal_row/2",
          object_key: proposal.proposal_id,
          operation: "insert",
          row: proposalRowFromProposal(proposal) as unknown as Record<string, JsonValue>,
          before: null,
          binding
        }),
        stateMember({
          row_schema: "rsi.experience_row/1",
          object_key: `${experience.experience_id}:${String(experience.version)}`,
          operation: "insert",
          row: experienceRowFromExperience(experience) as unknown as Record<string, JsonValue>,
          before: null,
          binding
        })
      );
      if (proposal.normalization.allocation !== "restored") {
        members.push(
          stateMember({
            row_schema: "rsi.validation_plan_row/1",
            object_key: plan.validation_plan_id,
            operation: "insert",
            row: validationPlanRowFromPlan(plan) as unknown as Record<string, JsonValue>,
            before: null,
            binding
          })
        );
      }
      for (const ref of rowSourceRefs(toJsonValue(proposal))) {
        const bytes = input.staged.get(ref);
        if (bytes !== undefined) {
          blobs.push({ bytes, ref, owner_type: "review", owner_id: proposal.proposal_id });
        }
      }
      const bodyBytes = input.staged.get(experience.body_ref);
      if (bodyBytes !== undefined) {
        blobs.push({
          bytes: bodyBytes,
          ref: experience.body_ref,
          owner_type: "experience",
          owner_id: experience.experience_id
        });
      }
    }

    if (members.length > 0) {
      const allocatorReady = input.connection
        .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'experience_version_allocators'")
        .get() !== undefined;
      const business = await commitReviewMembers({
        journal: input.journal,
        connection: input.connection,
        blobStore: input.blobStore,
        members,
        blobs,
        now,
        ...(allocatorReady
          ? { apply: (tx) => reserveExperienceVersions(tx, proposals, now) }
          : {})
      });
      if (!business.ok) return business;
    }

    const nextJob: ReviewJob = proposals.length > 0
      ? {
          ...job,
          state: "generating",
          stage: "experience_match_judge",
          version: job.version + 1,
          updated_at: now
        }
      : {
          ...job,
          state: "proposed",
          stage: "handoff",
          version: job.version + 1,
          updated_at: now
        };
    if (proposals.length === 0) delete (nextJob as { active_attempt_id?: string }).active_attempt_id;
    const jobCommit = await commitReviewMembers({
      journal: input.journal,
      connection: input.connection,
      blobStore: input.blobStore,
      members: [
        stateMember({
          row_schema: "rsi.review_job/2",
          object_key: job.job_id,
          operation: "transition",
          row: jobRowFromJob(nextJob) as unknown as Record<string, JsonValue>,
          before: jobRowFromJob(job) as unknown as Record<string, JsonValue>,
          binding,
          expected: { job_id: job.job_id, version: job.version }
        })
      ],
      blobs: [],
      now
    });
    if (!jobCommit.ok) return jobCommit;
    return ok({ job: nextJob, candidates: nowCandidates, proposals });
  };
}

/** T5: proposals end as `unverified`, then the job advances to `proposed`. */
export function createReviewJudgeCommit(input: {
  connection: SqliteConnection;
  blobStore: BlobStore;
  journal: ReviewJournal | null;
  now: () => number;
}): ReviewServiceDeps["judgeCommit"] {
  return async (commit) => {
    const { job, proposals, now } = commit;
    const binding = {
      task_id: job.task_id,
      branch_id: job.branch_id,
      input_epoch: job.input_epoch,
      goal_version: job.goal_version,
      config_version: job.config_version,
      watermark: job.stable_watermark
    } as VersionBinding;
    const members: CommitMember[] = [];
    const updated: Proposal[] = [];
    for (const proposal of proposals) {
      if (proposal.state !== "checked" && proposal.state !== "unverified") {
        updated.push(proposal);
        continue;
      }
      const currentRow = one<SqlRow>(
        input.connection,
        "SELECT * FROM proposals WHERE proposal_id = :id",
        { id: proposal.proposal_id }
      );
      const current = currentRow === null ? proposal : proposalFromRow(currentRow);
      const next: Proposal = {
        ...proposal,
        state: "unverified",
        version: current.version + 1,
        updated_at: now
      };
      updated.push(next);
      members.push(
        stateMember({
          row_schema: "rsi.proposal_row/2",
          object_key: proposal.proposal_id,
          operation: "transition",
          row: proposalRowFromProposal(next) as unknown as Record<string, JsonValue>,
          before: proposalRowFromProposal(current) as unknown as Record<string, JsonValue>,
          binding,
          expected: { proposal_id: proposal.proposal_id, version: current.version }
        })
      );
    }
    const nextJob: ReviewJob = {
      ...job,
      state: "proposed",
      stage: "handoff",
      version: job.version + 1,
      updated_at: now
    };
    delete (nextJob as { active_attempt_id?: string }).active_attempt_id;
    members.push(
      stateMember({
        row_schema: "rsi.review_job/2",
        object_key: job.job_id,
        operation: "transition",
        row: jobRowFromJob(nextJob) as unknown as Record<string, JsonValue>,
        before: jobRowFromJob(job) as unknown as Record<string, JsonValue>,
        binding,
        expected: { job_id: job.job_id, version: job.version }
      })
    );
    const committed = await commitReviewMembers({
      journal: input.journal,
      connection: input.connection,
      blobStore: input.blobStore,
      members,
      blobs: [],
      now
    });
    if (!committed.ok) return committed;
    return ok({ job: nextJob, proposals: updated });
  };
}

/** T6: proposals become `proposed`, the handoff body is frozen, job is done. */
export function createReviewHandoffCommit(input: {
  connection: SqliteConnection;
  blobStore: BlobStore;
  journal: ReviewJournal | null;
  now: () => number;
}): ReviewServiceDeps["handoffCommit"] {
  return async (commit) => {
    const { job, snapshot, handoff, proposals, now } = commit;
    const binding = snapshot.version_binding;
    const bodyBytes = canonicalJson(toJsonValue(handoff));
    const bodyStored = input.blobStore.putSync(bodyBytes);
    if (!bodyStored.ok) return bodyStored;
    const bodyRef = blobRef(bodyStored.value.hash, bodyBytes.byteLength);
    const members: CommitMember[] = [];
    const updated: Proposal[] = [];
    for (const proposal of proposals) {
      if (proposal.state === "checked" || proposal.state === "unverified") {
        const next: Proposal = {
          ...proposal,
          state: "proposed",
          handoff_id: handoff.handoff_id,
          version: proposal.version + 1,
          updated_at: now
        };
        updated.push(next);
        members.push(
          stateMember({
            row_schema: "rsi.proposal_row/2",
            object_key: proposal.proposal_id,
            operation: "transition",
            row: proposalRowFromProposal(next) as unknown as Record<string, JsonValue>,
            before: proposalRowFromProposal(proposal) as unknown as Record<string, JsonValue>,
            binding,
            expected: { proposal_id: proposal.proposal_id, version: proposal.version }
          })
        );
      } else {
        updated.push(proposal);
      }
    }
    const done = markJobDone(job, handoff.handoff_id as Id<"hand">, bodyRef, now);
    const nextJob: ReviewJob = { ...done, updated_at: now };
    members.push(
      stateMember({
        row_schema: "rsi.review_job/2",
        object_key: job.job_id,
        operation: "transition",
        row: jobRowFromJob(nextJob) as unknown as Record<string, JsonValue>,
        before: jobRowFromJob(job) as unknown as Record<string, JsonValue>,
        binding,
        expected: { job_id: job.job_id, version: job.version }
      })
    );
    const handoffRow = handoffRowFromHandoff(handoff, bodyRef) as unknown as Record<string, JsonValue>;
    const committed = await commitReviewMembers({
      journal: input.journal,
      connection: input.connection,
      blobStore: input.blobStore,
      members,
      blobs: [{ bytes: bodyBytes, ref: bodyRef, owner_type: "review", owner_id: handoff.handoff_id }],
      now,
      apply: (tx) => {
        const columns = Object.keys(handoffRow);
        tx.prepare(
          `INSERT INTO review_handoffs (${columns.join(", ")})
           VALUES (${columns.map((column) => `:${column}`).join(", ")})`
        ).run(
          Object.fromEntries(columns.map((column) => [column, sqlValue(handoffRow[column])])) as Record<string, SqlValue>
        );
        tx.prepare(
          `INSERT INTO review_handoff_delivery (
             handoff_id, job_id, state, attempts, last_error_code,
             next_attempt_at, created_at, updated_at
           ) VALUES (
             :handoff_id, :job_id, 'pending', 0, NULL,
             :next_attempt_at, :created_at, :updated_at
           )
           ON CONFLICT(handoff_id) DO NOTHING`
        ).run({
          handoff_id: handoff.handoff_id,
          job_id: handoff.job_id,
          next_attempt_at: now,
          created_at: now,
          updated_at: now
        });
        return null;
      }
    });
    if (!committed.ok) return committed;
    return ok({ job: nextJob, handoff, proposals: updated });
  };
}

/* ------------------------------------------------------------------ */
/* Local explicit review                                               */
/* ------------------------------------------------------------------ */

export interface ResolvedReviewTask {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly project_id: string | null;
  readonly goal_version: string;
  readonly config_version: string;
  readonly input_epoch: number;
  readonly watermark: number;
}

export interface LocalReviewStatus {
  readonly status: "queued" | "blocked_no_backend" | "existing";
  readonly request_id: string;
  readonly review_job_id: Id<"job">;
  readonly snapshot_id: Id<"snap">;
  readonly job_state: ReviewJob["state"];
  readonly stage: ReviewJob["stage"];
  readonly watermark: number;
  readonly block_reason?: string;
}

export interface SkillDiffView {
  readonly status: "ok";
  readonly id: string;
  readonly kind: "proposal" | "projection";
  readonly state: string;
  readonly diff_format?: string;
  readonly diff_ref?: SourceRef;
  readonly diff_hash?: Hash;
  readonly diff?: string;
  readonly target_object_type?: string;
  readonly target_path_or_block?: string;
  readonly experience_id?: string;
}

export interface SkillRevokeView {
  readonly status: "revoked" | "disabled" | "withdrawn";
  readonly id: string;
  readonly kind: "proposal" | "projection";
  readonly lifecycle?: ExperienceProjection["lifecycle"];
  readonly state?: Proposal["state"];
  readonly row_version?: number;
}

export interface SkillResolveView {
  readonly status: "no_conflict" | "pending_manual_merge";
  readonly id: string;
  readonly kind: "proposal" | "projection" | "write";
  readonly proposal_id?: string;
  readonly write_id?: string;
  readonly write_state?: string;
  readonly three_way_diff_ref?: SourceRef;
  readonly three_way_diff?: string;
  readonly options?: readonly string[];
}

export interface KernelReviewServices {
  readonly repository: ReviewRepository;
  readonly write: ReviewWritePort;
  readonly scheduler: ReviewScheduler;
  readonly review: ReviewService;
  readonly experience: ExperienceService;
  readonly worker: ReviewWorker;
  readonly generation: HostGenerationPort | null;
  /** True when this service opened the journal writer it writes through. */
  readonly journal_owned: boolean;
  /**
   * Idempotently flushes and closes the owned journal writer. A borrowed
   * writer stays open for its owner. Call after stopping review workers and
   * before closing the database.
   */
  dispose(): ReviewServiceDisposeResult;
  resolveTask(task: string | null): RevResult<ResolvedReviewTask>;
  enqueueReview(input: { task?: string | null; now?: number }): Promise<RevResult<LocalReviewStatus>>;
  skillDiff(input: { id: string }): Promise<RevResult<SkillDiffView>>;
  skillRevoke(input: { id: string; actor?: "user" | "authorization_owner" }): Promise<RevResult<SkillRevokeView>>;
  skillResolve(input: { id: string }): Promise<RevResult<SkillResolveView>>;
  /** Resumes durable cross-domain Experience rollback rows during startup. */
  reconcileExperienceRollbacks(input: { now: number }): Promise<RevResult<{
    readonly scanned: number;
    readonly reconciled: number;
    readonly recovery_required: number;
  }>>;
}

/**
 * Outcome of `KernelReviewServices.dispose()`.
 *
 * `owned` is true only when the service opened the journal writer itself.
 * `closed` is true only on the call that actually closed that writer, so a
 * repeated dispose is observably a no-op. A borrowed writer is never closed.
 */
export interface ReviewServiceDisposeResult {
  readonly owned: boolean;
  readonly closed: boolean;
}

/**
 * A journal writer supplied by the composition root. The service builds (or
 * accepts) a committer on this writer but never closes it; the supplier owns
 * the lifecycle. `relative_path` is the path recorded in `journal_state`.
 */
export interface ReviewServiceJournal {
  readonly writer: JournalWriter;
  readonly relative_path: string;
  /** Existing committer on the same writer; built from the writer when absent. */
  readonly committer?: JournalCommitter;
}

export interface ReviewServiceOptions {
  readonly connection: SqliteConnection;
  readonly config: EvoplugConfig;
  readonly home: string;
  readonly blob_store: BlobStore;
  readonly now: () => number;
  readonly layout?: HomeLayout;
  /**
   * Pre-opened journal writer borrowed from the composition root. Use this to
   * share the kernel's single journal writer instead of opening a second one.
   * The service never closes a borrowed writer; `dispose()` only closes a
   * writer the service opened itself.
   */
  readonly journal?: ReviewServiceJournal;
  readonly generation?: HostGenerationPort;
  /**
   * HOST generation adapter. When `generation` is absent, the composition root
   * wraps this adapter with the real `HostServiceProfileReadPort` and
   * `completeGenerationBackendSelection`; no profile is synthesized.
   */
  readonly generation_adapter?: HostGenerationAdapterPort;
  /** Frozen `host_contract` coordinates for the generation wrapper. */
  readonly host_contract?: () => CapabilityBinding | null;
  /** Evidence resolver used by the service profile read port. */
  readonly source_refs?: Pick<SourceRefPort, "resolve">;
  readonly host_binding?: HostEventBinding;
  readonly worker_id?: string;
  /**
   * HOST root resolver used by FND adoption to recover `approved_root` and the
   * root identity pin. Omitted means adoption stays fail-closed.
   */
  readonly root_resolver?: ExperienceRootResolver;
  /** Typed FND executor used by REV rollback materialization. */
  readonly rollback_executor?: ReviewExperienceRollbackExecutor;
  /**
   * Typed QP planner. It becomes live only when `judge` and `judge_prepare`
   * are supplied as well; the kernel then builds the production dispatcher
   * through `createPlannerJudgeDispatch`. Supplying only some of the trio is a
   * configuration error, never a silently inert injection.
   */
  readonly planner?: QuestionPlanner;
  /**
   * Typed Jev judge. Jev only judges; it never writes an Experience body or
   * adopts a projection. See `planner` for the activation requirement.
   */
  readonly judge?: JudgeService;
  /**
   * Resolves the real QP planning input and EVD judge input for one proposal
   * from the caller's ports (service profile, evidence, egress, endpoint,
   * model, budget). The kernel never fabricates any of these.
   */
  readonly judge_prepare?: PlannerJudgePrepare;
  /**
   * Active match-judge dispatcher. Mutually exclusive with the
   * `planner`/`judge`/`judge_prepare` trio and with `forced_pass_experiment`.
   * When none is supplied, every pending proposal becomes `degraded`.
   */
  readonly judge_dispatch?: ReviewServiceDeps["judgeDispatch"];
  /**
   * Explicit, named experiment that records a forced pass. It never claims a
   * Jev verdict and is off unless this object is passed. Mutually exclusive
   * with `judge_dispatch` and with the planner/judge trio.
   */
  readonly forced_pass_experiment?: ForcedPassExperimentPolicy;
  /**
   * Enables the real Experience candidate query (scope/host/version/expiry/
   * lifecycle filters, deterministic order, 32-row page). Default false keeps
   * the historical empty page.
   */
  readonly experience_candidates_enabled?: boolean;
  /**
   * Enables deterministic rollback target resolution over the adopted chain.
   * Default false keeps caller-supplied `target_version` semantics.
   */
  readonly rollback_target_resolution_enabled?: boolean;
  /**
   * Experience commit/verifier/HOST-fact ports. The independent Experience
   * module (`review-experience-ports.ts`) supplies these; absent ports stay
   * fail-closed rather than being synthesized here.
   */
  readonly experience_ports?: ReviewExperiencePorts;
}

/**
 * Resolves the one active match-judge dispatcher.
 *
 * Exactly one mechanism may be configured. The planner/judge trio is a real
 * production path; a partial trio throws because leaving an injected planner
 * or judge inert is the bug this option closes. An explicit `judge_dispatch`
 * keeps the historical escape hatch and is mutually exclusive with the trio
 * and with the forced-pass experiment.
 */
export function resolveJudgeDispatch(
  options: Pick<
    ReviewServiceOptions,
    "planner" | "judge" | "judge_prepare" | "judge_dispatch" | "forced_pass_experiment"
  >
): ReviewServiceDeps["judgeDispatch"] {
  const trioParts = [
    options.planner === undefined ? null : "planner",
    options.judge === undefined ? null : "judge",
    options.judge_prepare === undefined ? null : "judge_prepare"
  ].filter((part): part is string => part !== null);
  const configured = [
    options.judge_dispatch === undefined ? null : "judge_dispatch",
    options.forced_pass_experiment === undefined ? null : "forced_pass_experiment",
    trioParts.length === 3 ? "planner_judge_pipeline" : null
  ].filter((part): part is string => part !== null);
  if (configured.length > 1) {
    throw new Error(
      `ReviewServiceOptions configures conflicting judge dispatchers: ${configured.join(", ")}`
    );
  }
  if (trioParts.length > 0 && trioParts.length < 3) {
    const missing = ["planner", "judge", "judge_prepare"].filter(
      (part) => !trioParts.includes(part)
    );
    throw new Error(
      `ReviewServiceOptions ${trioParts.join("/")} supplied without ${missing.join("/")}; ` +
        "the typed judge pipeline requires all three, and the kernel will not keep them inert"
    );
  }
  if (options.judge_dispatch !== undefined) {
    return options.judge_dispatch;
  }
  if (options.forced_pass_experiment !== undefined) {
    if (trioParts.length > 0) {
      throw new Error(
        "forced_pass_experiment cannot be combined with planner/judge/judge_prepare"
      );
    }
    return createForcedPassExperimentDispatch(options.forced_pass_experiment);
  }
  if (trioParts.length === 3) {
    return createPlannerJudgeDispatch({
      planner: options.planner as QuestionPlanner,
      judge: options.judge as JudgeService,
      prepare: options.judge_prepare as PlannerJudgePrepare
    });
  }
  return degradedJudgeDispatch;
}

export interface ReviewExperiencePorts {
  readonly commit?: ExperienceCommitPort;
  readonly verifierRegistry?: ExperienceServiceDeps["verifierRegistry"];
  readonly writeAdoption?: ExperienceServiceDeps["writeAdoption"];
  readonly hostFacts?: ExperienceServiceDeps["hostFacts"];
  readonly readHostFacts?: ExperienceServiceDeps["readHostFacts"];
  readonly triggerFacts?: ExperienceServiceDeps["triggerFacts"];
  readonly rollbackExecutor?: ReviewExperienceRollbackExecutor;
}

function reviewClock(now: () => number): Clock {
  return {
    utcNowMs: now,
    monotonicNowMs: now,    monotonicRemainingMs: (deadline) => Math.max(0, deadline - now())
  };
}

/**
 * Resolves the single active `TriggerPolicy` for the frozen host binding and
 * freezes its stored canonical bytes as the trigger's snapshot ref. A missing
 * or ambiguous active policy is rejected; no policy is synthesized.
 */
export function resolveReviewPolicy(
  connection: SqliteConnection,
  blobStore: BlobStore,
  binding: HostEventBinding
): RevResult<{ ref: TriggerPolicyRef; snapshot_ref: SourceRef }> {
  if (!tableExists(connection, "trigger_policy")) {
    return revErr(revError("E_POLICY_UNAVAILABLE", "trigger_policy_validate", "table_missing"));
  }
  const listed = listInstalledTriggerPolicies(connection);
  if (!listed.ok) return revErr(revErrFromEnvelope(listed.error));
  const resolved = resolveTriggerPolicy(listed.value, {
    host_id: binding.host_id,
    mode: binding.mode,
    config_space: binding.config_space
  });
  if (!resolved.ok) return revErr(revErrFromEnvelope(resolved.error));
  const bytes = canonicalJson(toJsonValue(resolved.value));
  const stored = blobStore.putSync(bytes);
  if (!stored.ok) return revErr(revErrFromEnvelope(stored.error));
  return revOk({
    ref: policyRefOf(resolved.value),
    snapshot_ref: blobRef(stored.value.hash, bytes.byteLength)
  });
}

function validRef(value: string | null): SourceRef | null {
  if (value === null) return null;
  const parsed = parseSourceRef(value);
  return parsed.ok ? parsed.value.source_ref : null;
}

/**
 * Runtime shape of the commit stage handed over by HOST admission
 * (`packages/core/src/host/trigger/admission.ts`). Review's `LiveCommitStage`
 * declares a different `resolveDocument` key, so the transaction stage is
 * narrowed structurally to the stored `object_document` row it actually
 * returns.
 */
interface TriggerDocumentStage {
  resolveDocument(input: {
    owner: "host";
    object_type: "trigger_event";
    object_id: string;
    revision: number;
  }):
    | { readonly ok: true; readonly value: { readonly canonical_json?: unknown } | null }
    | { readonly ok: false; readonly error: ErrorEnvelope };
}

/**
 * Reads the frozen trigger document staged by HOST admission. The document is
 * the only source of host identity, policy ref, signals and boundary for the
 * transaction; a missing or mismatched document aborts the enqueue instead of
 * reconstructing a trigger from request fields.
 */
function stagedTriggerEvent(stage: LiveCommitStage, req: ReviewEnqueueRequest): TriggerEvent {
  const triggerInvalid = (path: string, rule: string): ErrorEnvelope =>
    makeErrorEnvelope({
      code: "E_REVIEW_TRIGGER_INVALID",
      category: "schema",
      message_key: "error.review_trigger_invalid",
      stage: "trigger_reconstruct",
      retryable: false,
      side_effect: "none",
      details: { kind: "field", path, rule }
    });
  const document = (stage as unknown as TriggerDocumentStage).resolveDocument({
    owner: "host",
    object_type: "trigger_event",
    object_id: req.trigger_event_id,
    revision: 1
  });
  if (!document.ok) throw document.error;
  const row = document.value as unknown as { canonical_json?: unknown } | null;
  if (row === null || typeof row.canonical_json !== "string") {
    throw triggerInvalid("trigger_event.document", "missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_json);
  } catch {
    throw triggerInvalid("trigger_event.document", "invalid_json");
  }
  const trigger = parsed as TriggerEvent;
  if (
    trigger === null ||
    typeof trigger !== "object" ||
    trigger.schema_version !== "rsi.trigger_event/1" ||
    trigger.trigger_event_id !== req.trigger_event_id ||
    trigger.decision !== "enqueue" ||
    trigger.dedupe?.trigger_dedupe_key !== req.trigger_dedupe_key ||
    trigger.review_scope_key !== req.review_scope_key
  ) {
    throw triggerInvalid("trigger_event.document", "request_mismatch");
  }
  return trigger;
}

/** Approved backend ids come from FND `review_backend`; `secret_ref` is not approval. */
export function configuredApprovedBackendIds(config: EvoplugConfig): readonly string[] {
  return config.review_backend.enabled ? [config.review_backend.backend_id] : [];
}

function composeGeneration(
  options: ReviewServiceOptions,
  sourceRefs: Pick<SourceRefPort, "resolve">
): HostGenerationPort | null {
  if (options.generation !== undefined) {
    return options.generation;
  }
  if (options.generation_adapter === undefined) {
    return null;
  }
  const profiles = createHostServiceProfileReadPort({
    connection: options.connection,
    source_refs: sourceRefs,
    now: options.now
  });
  return createHostGenerationPort({
    adapter: options.generation_adapter,
    profiles,
    host_contract: options.host_contract ?? (() => null),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

export function createReviewService(options: ReviewServiceOptions): KernelReviewServices {
  const layout = options.layout ?? homeLayout(options.home);
  const handle = resolveReviewJournal(options, layout, options.connection, options.now);
  try {
    return assembleReviewService(options, layout, handle);
  } catch (error) {
    // A construction failure after the writer opened must not leak the fd.
    // Borrowed writers stay open: their owner still holds them.
    handle.close();
    throw error;
  }
}

function assembleReviewService(
  options: ReviewServiceOptions,
  layout: HomeLayout,
  handle: ReviewJournalHandle
): KernelReviewServices {
  const { connection, config, blob_store: blobStore } = options;
  const now = options.now;
  const clock = reviewClock(now);
  const reviewSchemaReady = tableExists(connection, "review_jobs") && tableExists(connection, "proposals");
  const repository = createSqliteReviewRepository(connection, blobStore);
  const journal = handle.journal;
  const journalOwned = handle.owned && journal !== null;
  const dispose = (): ReviewServiceDisposeResult => ({
    owned: journalOwned,
    closed: handle.close()
  });
  const write = createSqliteReviewWritePort({ connection, blobStore, journal, now });
  const goal = createGoalPort(connection);
  const configPort = createConfigPort(connection);
  const sourceBytes = createSourceBytesPort(blobStore);
  const sourceRefs =
    options.source_refs ?? createSourceRefPort({ connection, blob_store: blobStore });
  const generation = composeGeneration(options, sourceRefs);
  /** Single instance shared by both enqueue entry points. */
  const experienceCandidates = createSqliteExperienceCandidatePort({
    connection,
    enabled: options.experience_candidates_enabled === true
  });

  /* --------------------------- task lookup --------------------------- */

  const resolveTask = (taskArg: string | null): RevResult<ResolvedReviewTask> => {
    let taskRow: SqlRow | null;
    if (taskArg !== null) {
      taskRow = one<SqlRow>(connection, "SELECT task_id, project_id FROM task WHERE task_id = :id", { id: taskArg });
    } else {
      const rows = all<SqlRow>(connection, "SELECT task_id, project_id FROM task ORDER BY created_at, task_id");
      if (rows.length !== 1) {
        return revErr(revError("E_SCHEMA", "review_task", rows.length === 0 ? "task_not_found" : "task_ambiguous"));
      }
      taskRow = rows[0] ?? null;
    }
    if (taskRow === null) {
      return revErr(revError("E_SCHEMA", "review_task", "task_not_found"));
    }
    const taskId = stringField(taskRow, "task_id") as Id<"task">;
    const branches = all<SqlRow>(
      connection,
      "SELECT branch_id, current_goal_version FROM branch WHERE task_id = :task_id ORDER BY updated_at DESC",
      { task_id: taskId }
    );
    const branch = branches[0];
    if (branch === undefined) {
      return revErr(revError("E_VERSION_BINDING", "review_task", "branch_not_found"));
    }
    if (branches.length > 1) {
      return revErr(revError("E_SCHEMA", "review_task", "branch_ambiguous"));
    }
    const branchId = stringField(branch, "branch_id") as Id<"br">;
    const eventAgg = one<SqlRow>(
      connection,
      `SELECT COALESCE(MAX(watermark), 0) AS watermark, COALESCE(MAX(input_epoch), 1) AS input_epoch
         FROM event_log WHERE branch_id = :branch_id`,
      { branch_id: branchId }
    );
    const watermark = eventAgg === null ? 0 : numberField(eventAgg, "watermark");
    const inputEpoch = eventAgg === null ? 1 : Math.max(1, numberField(eventAgg, "input_epoch"));
    return revOk({
      task_id: taskId,
      branch_id: branchId,
      project_id: nullableString(taskRow, "project_id"),
      goal_version: stringField(branch, "current_goal_version"),
      config_version: computeConfigVersion(config),
      input_epoch: inputEpoch,
      watermark
    });
  };

  /* --------------------------- source plan --------------------------- */

  const stableEvidenceFor = (
    task: ResolvedReviewTask
  ): RevResult<{ stable: SourceRef; outcome: SourceRef; refs: SourceRef[] }> => {
    const outcomeRow = one<SqlRow>(
      connection,
      `SELECT * FROM task_outcome_current WHERE task_id = :task_id AND branch_id = :branch_id
        ORDER BY revision DESC LIMIT 1`,
      { task_id: task.task_id, branch_id: task.branch_id }
    );
    if (outcomeRow === null) {
      return revErr(revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "task_outcome_missing"));
    }
    // An outcome revision is frozen against the six-field VersionBinding it
    // was evaluated at. `task_outcome_current` only selects the newest
    // revision on the branch, so a newer input epoch, goal/config or watermark
    // must not reuse an older outcome as the current stable boundary. The
    // local path cannot re-evaluate the outcome at a later boundary, so every
    // mismatch fails closed instead of promoting stale evidence.
    const outcomeBinding = jsonColumn<VersionBinding>(outcomeRow["version_binding_json"]);
    if (outcomeBinding === null) {
      return revErr(
        revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "task_outcome_binding_unreadable")
      );
    }
    if (outcomeBinding.task_id !== task.task_id || outcomeBinding.branch_id !== task.branch_id) {
      return revErr(
        revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "task_outcome_binding_target")
      );
    }
    if (outcomeBinding.input_epoch !== task.input_epoch) {
      return revErr(
        revError("E_REVIEW_BOUNDARY_PENDING", "trigger_validate", "outcome_input_epoch_stale")
      );
    }
    if (outcomeBinding.goal_version !== task.goal_version) {
      return revErr(
        revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "outcome_goal_version_stale")
      );
    }
    if (outcomeBinding.config_version !== task.config_version) {
      return revErr(
        revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "outcome_config_version_stale")
      );
    }
    if (outcomeBinding.watermark !== task.watermark) {
      return revErr(
        revError("E_REVIEW_BOUNDARY_PENDING", "trigger_validate", "outcome_watermark_stale")
      );
    }
    // `stable=true` is only honest at a boundary without pending work. The
    // local path cannot build a valid staged-with-gaps request (that needs
    // HOST's missing_evidence_refs), so any pending work or unstable marker is
    // rejected rather than promoting an ordinary input event to a stable one.
    const pendingRaw = nullableString(outcomeRow, "pending_work_json");
    let pending: unknown = null;
    if (pendingRaw !== null) {
      try {
        pending = JSON.parse(pendingRaw);
      } catch {
        pending = null;
      }
    }
    if (!Array.isArray(pending)) {
      return revErr(revError("E_REVIEW_BOUNDARY_PENDING", "trigger_validate", "pending_work_unreadable"));
    }
    if (pending.length > 0) {
      return revErr(revError("E_REVIEW_BOUNDARY_PENDING", "trigger_validate", "pending_work"));
    }
    const reasonCode = nullableString(outcomeRow, "reason_code");
    if (reasonCode === "boundary_unstable" || reasonCode === "pending_work") {
      return revErr(revError("E_REVIEW_BOUNDARY_PENDING", "trigger_validate", `reason_${reasonCode}`));
    }
    const refs: SourceRef[] = [];
    const success = jsonColumn<string[]>(outcomeRow["success_evidence_refs_json"]) ?? [];
    for (const candidate of success) {
      const ref = validRef(candidate);
      if (ref !== null) refs.push(ref);
    }
    const boundary = nullableString(outcomeRow, "boundary_event_id");
    if (boundary !== null) {
      const event = one<SqlRow>(
        connection,
        "SELECT content_ref, content_bytes FROM event_log WHERE event_id = :id",
        { id: boundary }
      );
      if (event !== null) {
        const contentRef = nullableString(event, "content_ref");
        const length = nullableNumber(event, "content_bytes");
        if (contentRef !== null && length !== null) {
          const ref = validRef(contentRef);
          if (ref !== null) refs.push(ref);
        }
      }
    }
    const stable = refs[0];
    if (stable === undefined) {
      return revErr(revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "stable_evidence"));
    }
    return revOk({ stable, outcome: stable, refs });
  };

  const buildSourcePlan = (
    task: ResolvedReviewTask,
    knownEvidence?: { stable: SourceRef; outcome: SourceRef; refs: SourceRef[] }
  ): RevResult<import("@evoplug/review").ReviewSnapshotSourcePlan> => {
    const evidenceResult = knownEvidence === undefined ? stableEvidenceFor(task) : revOk(knownEvidence);
    if (!evidenceResult.ok) return evidenceResult;
    const evidence = evidenceResult.value;
    const requirements: import("@evoplug/review").ReviewSnapshotSourcePlan["requirements"] = [];
    const reqRows = all<SqlRow>(
      connection,
      "SELECT requirement_id, revision, statement_ref FROM requirement_current WHERE branch_id = :branch_id AND status = 'active'",
      { branch_id: task.branch_id }
    );
    for (const row of reqRows) {
      const quote = validRef(nullableString(row, "statement_ref"));
      if (quote === null) continue;
      requirements.push({
        requirement_id: stringField(row, "requirement_id") as Id<"req">,
        version: numberField(row, "revision"),
        quote_ref: quote
      });
    }
    const userCorrections: SourceRef[] = [];
    for (const row of all<SqlRow>(
      connection,
      "SELECT quote_ref FROM feedback WHERE branch_id = :branch_id AND kind = 'correction'",
      { branch_id: task.branch_id }
    )) {
      const ref = validRef(nullableString(row, "quote_ref"));
      if (ref !== null) userCorrections.push(ref);
    }
    const verifications: SourceRef[] = [];
    for (const row of all<SqlRow>(
      connection,
      "SELECT source_ref FROM success_evidence WHERE branch_id = :branch_id",
      { branch_id: task.branch_id }
    )) {
      const ref = validRef(nullableString(row, "source_ref"));
      if (ref !== null) verifications.push(ref);
    }
    const evidenceRefs = [...new Set([
      evidence.stable,
      ...evidence.refs,
      ...requirements.map((item) => item.quote_ref),
      ...userCorrections,
      ...verifications
    ])].sort();
    const body: Omit<import("@evoplug/review").ReviewSnapshotSourcePlan, "source_plan_hash"> = {
      schema_version: "rsi.review_snapshot_source_plan/1",
      version_binding: {
        task_id: task.task_id,
        branch_id: task.branch_id,
        input_epoch: task.input_epoch,
        goal_version: task.goal_version,
        config_version: task.config_version,
        watermark: task.watermark
      },
      requirements,
      issues: [],
      user_correction_refs: [...new Set(userCorrections)].sort(),
      verification_refs: [...new Set(verifications)].sort(),
      artifacts: [],
      outcome_ref: evidence.outcome,
      stable_evidence_ref: evidence.stable,
      missing_evidence_refs: [],
      missing_requirement_ids: [],
      evidence_refs: evidenceRefs
    };
    return revOk({ ...body, source_plan_hash: reviewSnapshotSourcePlanHash(body) });
  };

  /* --------------------------- grant lookup --------------------------- */

  const activeGrant = (task: ResolvedReviewTask): Id<"grant"> | null => {
    const current = now();
    const rows = all<SqlRow>(
      connection,
      `SELECT grant_id, scope_json, actions_json FROM authorization_grant
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > :now)
          AND object_type = 'skill'
        ORDER BY issued_at DESC`,
      { now: current }
    );
    for (const row of rows) {
      const actions = jsonColumn<string[]>(row["actions_json"]) ?? [];
      if (!actions.includes("create") && !actions.includes("update")) continue;
      const scope = jsonColumn<{ project_ids?: string[] }>(row["scope_json"]) ?? {};
      if (
        task.project_id !== null &&
        scope.project_ids !== undefined &&
        scope.project_ids.length > 0 &&
        !scope.project_ids.includes(task.project_id)
      ) {
        continue;
      }
      return stringField(row, "grant_id") as Id<"grant">;
    }
    return null;
  };

  /* --------------------------- request/snapshot --------------------------- */

  const buildLocalRequest = (task: ResolvedReviewTask): RevResult<{
    trigger: TriggerEvent;
    request: ReviewEnqueueRequest;
    plan: import("@evoplug/review").ReviewSnapshotSourcePlan;
  }> => {
    const grant = activeGrant(task);
    if (grant === null) {
      return revErr(revError("E_AUTH_DENIED", "review_authorize", "grant_missing"));
    }
    const evidence = stableEvidenceFor(task);
    if (!evidence.ok) return evidence;
    const plan = buildSourcePlan(task, evidence.value);
    if (!plan.ok) return plan;
    if (plan.value.outcome_ref === null) {
      return revErr(revError("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_source", "outcome"));
    }
    const current = now();
    const binding = options.host_binding;
    if (binding === undefined) {
      return revErr(revError("E_REVIEW_TRIGGER_INVALID", "trigger_reconstruct", "host_binding_missing"));
    }
    const resolvedPolicy = resolveReviewPolicy(connection, blobStore, binding);
    if (!resolvedPolicy.ok) return resolvedPolicy;
    const stable = evidence.value.stable;
    const signals: TriggerEvent["signals"] = [
      {
        type: "user_request",
        strength: "claim",
        detector_version: "sigdet/1",
        evidence_refs: [stable],
        issue_ids: [],
        requirement_ids: [],
        detected_at: current
      }
    ];
    const reviewScopeKey = computeReviewScopeKey({
      scope: {
        task_id: task.task_id,
        branch_id: task.branch_id,
        input_epoch: task.input_epoch,
        goal_version: task.goal_version,
        config_version: task.config_version,
        ...(task.project_id === null ? {} : { project_id: task.project_id })
      },
      stable_watermark: task.watermark,
      stable_event_ids: [],
      pending_state: "none",
      pending_work_refs: [],
      review_kind: "explicit"
    });
    const boundary = computeBoundaryKey({
      scope: {
        task_id: task.task_id,
        branch_id: task.branch_id,
        input_epoch: task.input_epoch,
        goal_version: task.goal_version,
        config_version: task.config_version,
        ...(task.project_id === null ? {} : { project_id: task.project_id })
      },
      boundary_kind: "user_selected",
      stable_watermark: task.watermark,
      stable_event_ids: []
    });
    const signalDigest = computeSignalDigest(signals);
    const dedupeKey = computeTriggerDedupeKey({
      boundary_key: boundary,
      signal_digest: signalDigest,
      review_kind: "explicit"
    });
    const policy = resolvedPolicy.value.ref;
    const capabilityGate: TriggerEvent["capability_gate"] = [];
    const capabilityHash = canonicalHash(toJsonValue(capabilityGate));
    const trigger: TriggerEvent = {
      schema_version: "rsi.trigger_event/1",
      trigger_event_id: newId("trg", current),
      trigger_kind: "user_review_request",
      source_event_ref: stable,
      raw_event_ref: stable,
      host_binding: binding,
      policy_ref: policy,
      origin: {
        kind: "unknown",
        evidence_kind: "invocation_context",
        suppress_automatic: false
      },
      request_intent: "explicit_review",
      scope: {
        task_id: task.task_id,
        branch_id: task.branch_id,
        input_epoch: task.input_epoch,
        goal_version: task.goal_version,
        config_version: task.config_version,
        ...(task.project_id === null ? {} : { project_id: task.project_id })
      },
      identity_quality: "missing",
      signals,
      // Reached only after `stableEvidenceFor` accepted the current task
      // outcome: no pending work and no unstable marker. `stable`, the empty
      // pending set and the complete snapshot request therefore follow FND
      // facts rather than being assumed for an arbitrary input event.
      boundary: {
        candidate: true,
        stable: true,
        boundary_kind: "user_selected",
        stable_event_ids: [],
        source_event_ids: [],
        stable_watermark: task.watermark,
        goal_version: task.goal_version,
        pending_state: "none",
        pending_work_refs: [],
        unstable_reasons: []
      },
      stable_evidence_ref: stable,
      review_scope_key: reviewScopeKey,
      capability_gate: capabilityGate,
      dedupe: {
        source_event_key: canonicalHash({ task: task.task_id, branch: task.branch_id }),
        boundary_key: boundary,
        signal_digest: signalDigest,
        trigger_dedupe_key: dedupeKey
      },
      decision: "enqueue",
      decision_reason: "explicit_enqueued",
      authorization_ref: grant,
      policy_snapshot_ref: resolvedPolicy.value.snapshot_ref,
      decision_version: 1,
      decided_at: current,
      evidence_refs: [stable]
    };
    const request: ReviewEnqueueRequest = {
      schema_version: "rsi.review_enqueue/1",
      request_id: newId("req", current),
      trigger_event_id: trigger.trigger_event_id,
      trigger_kind: "user_review_request",
      review_scope_key: reviewScopeKey,
      boundary_key: boundary,
      signal_digest: signalDigest,
      trigger_dedupe_key: dedupeKey,
      stable_event_ids: [],
      stable_watermark: task.watermark,
      goal_version: task.goal_version,
      scope: trigger.scope,
      pending_state: "none",
      pending_work_refs: [],
      stable: true,
      stable_evidence_ref: stable,
      policy_ref: policy,
      origin: trigger.origin,
      capability_snapshot_hash: capabilityHash,
      budget_policy_ref: "budget://default",
      review_kind: "explicit",
      authorization_ref: grant,
      snapshot_request: { mode: "stable", completeness: "complete", missing_evidence_refs: [] },
      created_at: current
    };
    return revOk({ trigger, request, plan: plan.value });
  };

  const quotaPolicy = (): import("@evoplug/review").ReviewQuotaPolicy => {
    const base: Omit<import("@evoplug/review").ReviewQuotaPolicy, "quota_policy_hash"> = {
      schema_version: "rsi.review_quota_policy/1",
      budget_policy_ref: "budget://default",
      budget_policy_version: "bpol/1",
      budget_policy_hash: canonicalHash(toJsonValue({ policy: "budget://default" })),
      purpose: "review_generate",
      max_attempts: 2,
      max_input_tokens: 200_000,
      max_output_tokens: 65_536,
      request_max_tokens: 180_000,
      question_max_tokens: 20_000,
      request_margin_tokens: 1_000,
      question_margin_tokens: 1_000,
      max_cost_micros: null,
      wall_ms: 600_000,
      reserve_ms: 60_000,
      min_work_ms: 1_000,
      attempt_charge_at: "claim",
      attempt_refundable: false
    };
    return { ...base, quota_policy_hash: reviewQuotaPolicyHash(base) };
  };

  const localEgress = (plan: import("@evoplug/review").ReviewSnapshotSourcePlan): EgressApprovedSourcesView => ({
    schema_version: "rsi.egress_approved_sources_view/1",
    egress_policy_ref: "egress://local-only",
    egress_policy_version: "egress/local/1",
    approved_evidence_refs: [...plan.evidence_refs],
    approved_experience_refs: [],
    rejected_sources: []
  });

  const persistSnapshotAndJob = async (input: {
    snapshot: ReviewSnapshot;
    job: ReviewJob;
    request: ReviewEnqueueRequest;
    result: ReviewEnqueueResult;
  }): Promise<Result<void, ErrorEnvelope>> => {
    const snapshotBytes = canonicalJson(toJsonValue(input.snapshot));
    const snapshotRef = blobRef(hashBytes(snapshotBytes), snapshotBytes.byteLength);
    // The snapshot's policy evidence is the frozen TriggerPolicy bytes. Keep
    // them registered alongside the snapshot row so the ref stays retrievable
    // and accounted for; a missing policy blob aborts the enqueue.
    const policyBlob = readSourceRef(connection, blobStore, input.snapshot.policy_snapshot_ref);
    if (!policyBlob.ok) return policyBlob;
    const snapshotRow = toJsonObject(snapshotRowFromSnapshot(input.snapshot, snapshotRef));
    const requestRow = toJsonObject({
      request_id: input.request.request_id,
      schema_version: "rsi.review_enqueue/1",
      request_hash: canonicalHash(toJsonValue(input.request)),
      trigger_event_id: input.request.trigger_event_id,
      trigger_kind: input.request.trigger_kind,
      trigger_dedupe_key: input.request.trigger_dedupe_key,
      version_binding_json: canonicalJsonText(toJsonValue(input.snapshot.version_binding)),
      stable_evidence_ref: input.request.stable_evidence_ref,
      request_json: canonicalJsonText(toJsonValue(input.request)),
      result_json: canonicalJsonText(toJsonValue(input.result)),
      review_job_id: input.job.job_id,
      created_at: input.request.created_at
    });
    const jobRow = toJsonObject(jobRowFromJob(input.job));
    const binding = input.snapshot.version_binding;
    const member = (
      row_schema: string,
      object_key: string,
      row: Record<string, JsonValue>,
      expected: Readonly<Record<string, SqlValue>>
    ): CommitMember | null => {
      const table = TABLE_BY_SCHEMA[row_schema];
      if (table === undefined) return null;
      return {
        row_schema,
        object_key,
        operation: "insert",
        row,
        before: null,
        binding,
        table: table.table,
        primary_key: table.primary_key,
        expected,
        blob_hashes: []
      };
    };
    const members = [
      member("rsi.review_snapshot/1", input.snapshot.snapshot_id, snapshotRow, {}),
      member("rsi.review_job/2", input.job.job_id, jobRow, {}),
      member("rsi.review_enqueue_request_row/1", input.request.request_id, requestRow, {})
    ].filter((entry): entry is CommitMember => entry !== null);
    return commitReviewMembers({
      journal,
      connection,
      blobStore,
      members,
      blobs: [
        {
          bytes: snapshotBytes,
          ref: snapshotRef,
          owner_type: "review",
          owner_id: input.snapshot.snapshot_id
        },
        {
          bytes: policyBlob.value.bytes,
          ref: input.snapshot.policy_snapshot_ref,
          owner_type: "review",
          owner_id: input.snapshot.snapshot_id
        }
      ],
      now: now()
    });
  };

  const enqueueReview = async (input: { task?: string | null; now?: number }): Promise<RevResult<LocalReviewStatus>> => {
    if (!reviewSchemaReady) {
      return revErr(revError("E_STORAGE_UNAVAILABLE", "review_storage", "review_schema_missing"));
    }
    const resolved = resolveTask(input.task ?? null);
    if (!resolved.ok) return resolved;
    const task = resolved.value;
    const existing = one<SqlRow>(
      connection,
      "SELECT * FROM review_jobs WHERE task_id = :task_id ORDER BY created_at DESC LIMIT 1",
      { task_id: task.task_id }
    );
    if (existing !== null) {
      const job = jobFromRow(existing);
      if (job.state !== "stale" && job.state !== "failed" && job.state !== "cancelled") {
        return revOk({
          status: "existing",
          request_id: job.request_id,
          review_job_id: job.job_id,
          snapshot_id: job.snapshot_id,
          job_state: job.state,
          stage: job.stage,
          watermark: job.stable_watermark,
          ...(job.block_reason === undefined ? {} : { block_reason: job.block_reason })
        });
      }
    }
    const built = buildLocalRequest(task);
    if (!built.ok) return built;
    const { trigger, request, plan } = built.value;
    const preparedInput = {
      schema_version: "rsi.prepare_review_enqueue_in/1" as const,
      req: request,
      trigger
    };
    const prepared = await prepareReviewEnqueue(
      {
        repository,
        sourcePlan: {
          readSourcePlan: async () => ok(plan)
        },
        candidates: experienceCandidates,
        sourceFacts: {
          readFacts: async (query) => {
            const facts: import("@evoplug/review").ReviewSourceBinding[] = [];
            for (const ref of query.refs) {
              const resolvedRef = readSourceRef(connection, blobStore, ref);
              if (!resolvedRef.ok) {
                return resolvedRef;
              }
              facts.push({
                schema_version: "rsi.review_source_binding/1",
                gate: query.gate,
                source_kind: "evidence",
                ref,
                retrievable: true,
                content_version: resolvedRef.value.content_hash,
                range_content_hash: resolvedRef.value.range_hash,
                source_metadata_digest: canonicalHash(toJsonValue({ ref, kind: "resolved" }))
              });
            }
            return ok({
              schema_version: "rsi.review_source_fact_page/1",
              query_hash: canonicalHash(toJsonValue(query)),
              facts
            });
          },
          recheckMetadataInTransaction: (_tx, _query, preparedFacts) =>
            ok({
              schema_version: "rsi.review_source_metadata_check/1",
              query_hash: canonicalHash(toJsonValue({ refs: preparedFacts.facts.map((fact) => fact.ref) })),
              refs: []
            })
        },
        egressPreparation: {
          prepareApprovedSources: async () =>
            revErrFromEnvelope(
              makeErrorEnvelope({
                code: "E_REVIEW_EGRESS_NOT_APPROVED",
                category: "authorization",
                message_key: "error.review_egress_not_approved",
                stage: "egress_prepare",
                retryable: false,
                side_effect: "none",
                details: { kind: "egress", policy_version: "egress/local/1", denied_dimension: "approval", refs: [] }
              })
            ) as never
        },
        policySupported: (version) => version === "1.0.0"
      },
      preparedInput
    );
    const outputPolicy = defaultReviewOutputPolicySource.load();
    const snapshot = buildReviewSnapshot({
      snapshot_id: newId("snap", now()),
      request,
      trigger,
      prepared,
      version_binding: {
        task_id: task.task_id,
        branch_id: task.branch_id,
        input_epoch: task.input_epoch,
        goal_version: task.goal_version,
        config_version: task.config_version,
        watermark: task.watermark
      },
      quota: quotaPolicy(),
      output_policy: outputPolicy,
      egress: localEgress(plan),
      permission_scope_ref: request.stable_evidence_ref,
      now: now()
    });
    const job = buildReviewJob({
      job_id: newId("job", now()),
      snapshot,
      request,
      now: now(),
      supersedesJobId: null,
      supersessionDepth: 0
    });
    if (generation === null) {
      job.state = "blocked_no_backend";
      job.stage = "generate";
      job.block_reason = "no_approved_backend";
      job.backend = {
        ...job.backend,
        missing_capabilities: [
          { status: "unknown", evidence_stage: "none", evidence_refs: [] },
          { status: "unknown", evidence_stage: "none", evidence_refs: [] },
          { status: "unknown", evidence_stage: "none", evidence_refs: [] }
        ],
        cancellation: "blocked",
        recovery: "blocked"
      };
    }
    const result: ReviewEnqueueResult = {
      schema_version: "rsi.review_enqueue_result/1",
      request_id: request.request_id,
      disposition: "created",
      review_job_id: job.job_id,
      stored_trigger_event_id: trigger.trigger_event_id
    };
    const committed = await persistSnapshotAndJob({ snapshot, job, request, result });
    if (!committed.ok) {
      return revErr(revErrFromEnvelope(committed.error));
    }
    return revOk({
      status: job.state === "blocked_no_backend" ? "blocked_no_backend" : "queued",
      request_id: request.request_id,
      review_job_id: job.job_id,
      snapshot_id: snapshot.snapshot_id,
      job_state: job.state,
      stage: job.stage,
      watermark: job.stable_watermark,
      ...(job.block_reason === undefined ? {} : { block_reason: job.block_reason })
    });
  };

  /* --------------------------- review service --------------------------- */

  const staticCheckStaged = new Map<SourceRef, Uint8Array>();
  const reviewDeps: ReviewServiceDeps = {
    repo: repository,
    write,
    budget: createReviewBudgetPort({ connection, journal, now }),
    approvedBackendIds: configuredApprovedBackendIds(config),
    generation: generation ?? {
      selectBackend: async () => ({
        ok: true,
        value: {
          state: "blocked_no_backend",
          reason: "no_approved_backend",
          missing: [
            { status: "unknown", evidence_stage: "none", evidence_refs: [] }
          ],
          evidence_refs: []
        }
      }),
      create: async () => ({
        ok: false,
        error: { code: "E_UNSUPPORTED", retryable: false }
      }),
      authenticate: async () => ({
        ok: false,
        error: { code: "E_UNSUPPORTED", retryable: false }
      }),
      cancel: async () => ({
        ok: false,
        error: { code: "E_UNSUPPORTED", retryable: false }
      }),
      recover: async () => ({
        ok: false,
        error: { code: "E_UNSUPPORTED", retryable: false }
      }),
      readOutput: async () => ({
        ok: false,
        error: { code: "E_UNSUPPORTED", retryable: false }
      })
    },
    sourceBytes,
    goal,
    config: configPort,
    clock,
    policySupported: (version) => version === "1.0.0",
    outputPolicy: defaultReviewOutputPolicySource,
    buildAttempt: (input) =>
      buildAttemptEnvironment({
        connection,
        config,
        blobStore,
        home: options.home,
        job: input.job,
        snapshot: input.snapshot,
        backend: input.backend,
        quota: input.quota,
        attempt_id: input.attempt_id
      }),
    buildGeneratorInput: (input) =>
      buildGeneratorInputValue({
        connection,
        config,
        blobStore,
        job: input.job,
        attemptId: input.attempt.attempt_id,
        snapshot: input.snapshot,
        quota: {
          input_tokens_estimated: input.attempt.budget.input_tokens_estimated,
          output_tokens_reserved: input.attempt.budget.output_tokens_reserved,
          deadline_ms:
            input.attempt.deadline_at ??
            input.attempt.created_at + input.attempt.budget.wall_ms_reserved
        }
      }),
    acceptanceCommit: createReviewAcceptanceCommit({ connection, blobStore, journal, now }),
    staticCheckCommit: createReviewStaticCheckCommit({
      connection,
      blobStore,
      journal,
      now,
      staged: staticCheckStaged
    }),
    judgeCommit: createReviewJudgeCommit({ connection, blobStore, journal, now }),
    handoffCommit: createReviewHandoffCommit({ connection, blobStore, journal, now }),
    staticCheckContext: async (input) => {
      staticCheckStaged.clear();
      try {
        return ok(
          createKernelStaticCheckContext({
            connection,
            config,
            blobStore,
            job: input.job,
            snapshot: input.snapshot,
            attempt: input.attempt,
            now: input.now,
            staged: staticCheckStaged
          })
        );
      } catch (error) {
        return {
          ok: false,
          status: "rejected",
          error: unavailable(
            "static_check",
            error instanceof Error ? error.message : "kernel.review_static_check_failed"
          )
        };
      }
    },
    planner: options.planner ?? failClosedPlanner,
    judge: options.judge ?? failClosedJudge,
    judgeDispatch: resolveJudgeDispatch(options),
    handoffRead: createReviewHandoffReadPort(
      createKernelHandoffCloseRepository(connection, blobStore)
    )
  };
  const review = new DefaultReviewService(reviewDeps);

  /* --------------------------- scheduler --------------------------- */

  const scheduler: ReviewScheduler = {
    prepareEnqueue: async (input) =>
      prepareReviewEnqueue(
        {
          repository,
          sourcePlan: {
            readSourcePlan: async (query) => {
              const task = resolveTask(query.request.scope.task_id);
              if (!task.ok) return { ok: false, status: "rejected", error: unavailable("source_plan", task.error.code) };
              const plan = buildSourcePlan(task.value);
              if (!plan.ok) {
                return {
                  ok: false,
                  status: "rejected",
                  error: unavailable("source_plan", plan.error.code)
                };
              }
              return ok(plan.value);
            }
          },
          candidates: experienceCandidates,
          sourceFacts: {
            readFacts: async (query) => {
              const facts: import("@evoplug/review").ReviewSourceBinding[] = [];
              for (const ref of query.refs) {
                const resolvedRef = readSourceRef(connection, blobStore, ref);
                if (!resolvedRef.ok) return resolvedRef;
                facts.push({
                  schema_version: "rsi.review_source_binding/1",
                  gate: query.gate,
                  source_kind: "evidence",
                  ref,
                  retrievable: true,
                  content_version: resolvedRef.value.content_hash,
                  range_content_hash: resolvedRef.value.range_hash,
                  source_metadata_digest: canonicalHash(toJsonValue({ ref, kind: "resolved" }))
                });
              }
              return ok({
                schema_version: "rsi.review_source_fact_page/1",
                query_hash: canonicalHash(toJsonValue(query)),
                facts
              });
            },
            recheckMetadataInTransaction: (_tx, _query, preparedFacts) =>
              ok({
                schema_version: "rsi.review_source_metadata_check/1",
                query_hash: canonicalHash(toJsonValue({ refs: preparedFacts.facts.map((fact) => fact.ref) })),
                refs: []
              })
          },
          egressPreparation: {
            prepareApprovedSources: async () => ({
              ok: false,
              status: "rejected",
              error: makeErrorEnvelope({
                code: "E_REVIEW_EGRESS_NOT_APPROVED",
                category: "authorization",
                message_key: "error.review_egress_not_approved",
                stage: "egress_prepare",
                retryable: false,
                side_effect: "none",
                details: { kind: "egress", policy_version: "egress/local/1", denied_dimension: "approval", refs: [] }
              })
            })
          },
          policySupported: (version) => version === "1.0.0"
        },
        input
      ),
    enqueueInTransaction: (stage, req, prepared) => {
      const computes = buildSourcePlan({
        task_id: req.scope.task_id as Id<"task">,
        branch_id: req.scope.branch_id as Id<"br">,
        project_id: req.scope.project_id ?? null,
        goal_version: req.goal_version,
        config_version: req.scope.config_version,
        input_epoch: req.scope.input_epoch,
        watermark: req.stable_watermark
      });
      const plan = computes.ok
        ? computes.value
        : {
            schema_version: "rsi.review_snapshot_source_plan/1" as const,
            version_binding: {
              task_id: req.scope.task_id as Id<"task">,
              branch_id: req.scope.branch_id as Id<"br">,
              input_epoch: req.scope.input_epoch,
              goal_version: req.goal_version,
              config_version: req.scope.config_version,
              watermark: req.stable_watermark
            },
            requirements: [],
            issues: [],
            user_correction_refs: [],
            verification_refs: [],
            artifacts: [],
            outcome_ref: req.stable_evidence_ref,
            stable_evidence_ref: req.stable_evidence_ref,
            missing_evidence_refs: [],
            missing_requirement_ids: [],
            evidence_refs: [req.stable_evidence_ref],
            source_plan_hash: reviewSnapshotSourcePlanHash({
              schema_version: "rsi.review_snapshot_source_plan/1",
              version_binding: {
                task_id: req.scope.task_id as Id<"task">,
                branch_id: req.scope.branch_id as Id<"br">,
                input_epoch: req.scope.input_epoch,
                goal_version: req.goal_version,
                config_version: req.scope.config_version,
                watermark: req.stable_watermark
              },
              requirements: [],
              issues: [],
              user_correction_refs: [],
              verification_refs: [],
              artifacts: [],
              outcome_ref: req.stable_evidence_ref,
              stable_evidence_ref: req.stable_evidence_ref,
              missing_evidence_refs: [],
              missing_requirement_ids: [],
              evidence_refs: [req.stable_evidence_ref]
            })
          };
      const trigger = stagedTriggerEvent(stage, req);
      const staged = enqueueInTransactionSync({
        stage,
        req,
        prepared,
        trigger,
        deps: {
          budgetPolicy: {
            getScopeInTransaction: () =>
              ok({
                schema_version: "rsi.budget_scope_policy_view/1",
                budget_policy_ref: req.budget_policy_ref,
                budget_policy_version: "bpol/1",
                content_hash: canonicalHash({ policy: req.budget_policy_ref }),
                scope: {
                  purpose: "review_generate",
                  max_attempts: 2,
                  max_input_tokens: 200_000,
                  max_output_tokens: 65_536,
                  request_max_tokens: 180_000,
                  question_max_tokens: 20_000,
                  request_margin_tokens: 1_000,
                  question_margin_tokens: 1_000,
                  max_cost_micros: null,
                  wall_ms: 600_000,
                  reserve_ms: 60_000,
                  min_work_ms: 1_000,
                  attempt_charge_at: "claim",
                  attempt_refundable: false
                }
              })
          },
          outputPolicy: defaultReviewOutputPolicySource,
          egressRead: {
            getApprovedSourcesInTransaction: (_tx, egressInput) =>
              ok({
                schema_version: "rsi.egress_approved_sources_view/1",
                egress_policy_ref: egressInput.policy_ref,
                egress_policy_version: "egress/local/1",
                approved_evidence_refs: [...egressInput.evidence_refs],
                approved_experience_refs: [...egressInput.experience_refs],
                rejected_sources: []
              })
          },
          permissionScopeRef: req.stable_evidence_ref,
          policySupported: (version) => version === "1.0.0"
        },
        now: req.created_at
      });
      if (!staged.ok) {
        throw staged.error;
      }
      void plan;
      return staged.value.result;
    }
  };

  /* --------------------------- worker --------------------------- */

  const runner: GeneratorRunnerPort = {
    run: async () => revErr(revError("E_REVIEW_BACKEND_UNAVAILABLE", "generate", "no_generation_port")),
    cancel: async () => "unsupported"
  };
  const worker = new ReviewWorker({
    service: review,
    runner,
    clock,
    worker_id: options.worker_id ?? "kernel-review-worker",
    heartbeat_interval_ms: 30_000,
    cancelRequested: async (attemptId) => {
      const attempt = await repository.getAttempt(attemptId);
      return attempt?.cancel.requested_at !== undefined;
    }
  });

  /* --------------------------- experience --------------------------- */

  const experienceCommit: ExperienceCommitPort = {
    recordAdoption: async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("adoption", "kernel.review_adoption_unavailable")
    }),
    beginTrial: async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("begin_trial", "kernel.review_trial_unavailable")
    }),
    recordUsage: async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("usage_record", "kernel.review_usage_unavailable")
    }),
    applyLifecycle: async ({ projection, action, now: at }) => {
      if (action.kind === "none") {
        return {
          ok: false,
          status: "rejected",
          error: unavailable("lifecycle", "kernel.review_lifecycle_no_predicate")
        };
      }
      const reason: ExperienceLifecycleEvent["reason"] =
        action.kind === "disabled" || action.kind === "revoked"
          ? action.reason
          : action.kind === "retained"
            ? "retention_rule_met"
            : "trial_started";
      const after: ExperienceProjection = action.kind === "disabled" || action.kind === "revoked"
        ? disabledProjection(projection, action.reason, at, projection.superseded_by_projection_id)
        : {
            ...projection,
            lifecycle: action.kind === "retained" ? "retained" : "trial",
            lifecycle_reason: action.kind === "retained" ? "retention_rule_met" : "trial_started",
            retention: { ...projection.retention, last_evaluated_at: at },
            row_version: projection.row_version + 1,
            updated_at: at
          };
      const events = await repository.listLifecycleEvents(projection.projection_id);
      const eventId = newId("lif", at);
      after.last_lifecycle_event_id = eventId;
      const event = buildLifecycleEvent({
        event_id: eventId,
        projection_before: projection,
        projection_after: after,
        sequence: nextSequence(events),
        reason,
        trigger: {
          kind: action.kind === "retained" ? "retention_evaluated" : action.kind === "begin_trial" ? "begin_trial" : "usage_verification",
          ref: null,
          usage_ids: []
        },
        write_id: projection.adoption_binding.write_id,
        version_binding: projection.adoption_binding.version_binding,
        now: at
      });
      const saved = await write.saveProjection(after, projection.row_version);
      if (!saved.ok) return saved;
      const eventBytes = canonicalJson(toJsonValue(event));
      const ref = blobRef(hashBytes(eventBytes), eventBytes.byteLength);
      const eventSaved = await write.saveLifecycleEvent(event, ref);
      if (!eventSaved.ok) return eventSaved;
      return ok({ projection: after, event });
    },
    extendWindow: async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("extend_window", "kernel.review_window_unavailable")
    }),
    revoke: async ({ projection, reason, now: at }) => {
      const next = disabledProjection(projection, reason, at, projection.superseded_by_projection_id);
      const events = await repository.listLifecycleEvents(projection.projection_id);
      const event = buildLifecycleEvent({
        event_id: newId("lif", at),
        projection_before: projection,
        projection_after: { ...next, last_lifecycle_event_id: "" },
        sequence: nextSequence(events),
        reason,
        trigger: {
          kind: reason === "authorization_revoked" ? "authorization_change" : "user_action",
          ref: null,
          usage_ids: []
        },
        write_id: projection.adoption_binding.write_id,
        version_binding: projection.adoption_binding.version_binding,
        now: at
      });
      next.last_lifecycle_event_id = event.event_id;
      const eventWithAfter = buildLifecycleEvent({
        event_id: event.event_id,
        projection_before: projection,
        projection_after: next,
        sequence: event.sequence,
        reason,
        trigger: event.trigger,
        write_id: projection.adoption_binding.write_id,
        version_binding: projection.adoption_binding.version_binding,
        now: at
      });
      const saved = await write.saveProjection(next, projection.row_version);
      if (!saved.ok) return saved;
      const eventBytes = canonicalJson(toJsonValue(eventWithAfter));
      const ref = blobRef(hashBytes(eventBytes), eventBytes.byteLength);
      const eventSaved = await write.saveLifecycleEvent(eventWithAfter, ref);
      if (!eventSaved.ok) return eventSaved;
      return ok(next);
    },
    rollback: async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("rollback", "kernel.review_rollback_unavailable")
    })
  };

  const experiencePorts =
    options.experience_ports ??
    createReviewExperiencePorts({
      connection,
      blobStore,
      repository,
      journal,
      now,
      goal,
      // FND's adoption reader is local (three committed rows on the shared
      // connection). `approved_root` and the root identity pin are not in
      // those rows, so a caller-supplied HOST resolver is required; without it
      // the adapter fails closed rather than reusing the proposal's path.
      writeAdoption: createWriteAdoptionReadPort({ connection }),
      ...(options.root_resolver === undefined ? {} : { rootResolver: options.root_resolver }),
      ...(options.rollback_executor === undefined ? {} : { rollbackExecutor: options.rollback_executor }),
      rollbackTargetResolutionEnabled: options.rollback_target_resolution_enabled === true
    });
  const experienceService = new DefaultExperienceService({
    repo: repository,
    write,
    commit: experiencePorts.commit ?? experienceCommit,
    verifierRegistry: experiencePorts.verifierRegistry ?? {
      resolve: async () => ({
        ok: false,
        status: "rejected",
        error: unavailable("verifier", "kernel.review_verifier_unavailable")
      })
    },
    writeAdoption: experiencePorts.writeAdoption ?? {
      getAdoptionInTransaction: () => ({
        ok: false,
        status: "rejected",
        error: unavailable("adoption", "kernel.review_write_adoption_unavailable")
      }),
      getAdoption: async () => ({
        ok: false,
        status: "rejected",
        error: unavailable("adoption", "kernel.review_write_adoption_unavailable")
      })
    },
    goal,
    hostFacts: experiencePorts.hostFacts ?? {
      readInTransaction: () => ({
        ok: false,
        status: "rejected",
        error: unavailable("host_facts", "kernel.review_host_facts_unavailable")
      })
    },
    readHostFacts: experiencePorts.readHostFacts ?? (async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("host_facts", "kernel.review_host_facts_unavailable")
    })),
    triggerFacts: options.experience_ports?.triggerFacts ?? (async () => ({
      ok: false,
      status: "rejected",
      error: unavailable("trigger", "kernel.review_trigger_facts_unavailable")
    })),
    now: (utc) => utc
  });

  const reconcileExperienceRollbacks = async (input: {
    readonly now: number;
  }): Promise<RevResult<{
    readonly scanned: number;
    readonly reconciled: number;
    readonly recovery_required: number;
  }>> => {
    if (!tableExists(connection, "experience_rollback_reconciliation")) {
      return revErr(revError("E_STORAGE_UNAVAILABLE", "rollback_reconcile", "reconciliation_table_missing"));
    }
    const rows = all<SqlRow>(
      connection,
      `SELECT operation_id, fnd_write_id, source_projection_id, target_projection_id,
              target_experience_version
         FROM experience_rollback_reconciliation
        WHERE state IN ('pending_fnd', 'fnd_verified')
        ORDER BY updated_at ASC, operation_id ASC`
    );
    let reconciled = 0;
    let recoveryRequired = 0;
    const markRecoveryRequired = (operationId: string, code: string): void => {
      connection.prepare(
        `UPDATE experience_rollback_reconciliation
            SET state = 'recovery_required', error_code = :error_code, updated_at = :updated_at
          WHERE operation_id = :operation_id
            AND state IN ('pending_fnd', 'fnd_verified')`
      ).run({ operation_id: operationId, error_code: code, updated_at: input.now });
      recoveryRequired += 1;
    };
    for (const row of rows) {
      const operationId = stringField(row, "operation_id");
      const source = await repository.getProjection(stringField(row, "source_projection_id"));
      if (source === null) {
        markRecoveryRequired(operationId, "source_projection_missing");
        continue;
      }
      const targetVersion = numberField(row, "target_experience_version");
      const target = await repository.getProjection(stringField(row, "target_projection_id"));
      const targetWriteId = target?.write.write_id;
      if (targetWriteId === undefined) {
        markRecoveryRequired(operationId, "target_projection_missing");
        continue;
      }
      /* The durable row records the verified rollback write once FND commits;
       * its intent carries the grant that actually authorized the rollback.
       * Only a still-pending row (no FND write yet) falls back to the target
       * write's grant, and a `side_effect=none` failure discards that row. */
      const fndWriteId = stringField(row, "fnd_write_id");
      const authorizationWriteId = fndWriteId.startsWith("pending:")
        ? targetWriteId
        : fndWriteId;
      const grant = one<SqlRow>(
        connection,
        "SELECT grant_id FROM write_intent WHERE write_id = :write_id",
        { write_id: authorizationWriteId }
      );
      const grantId = grant === null ? "" : stringField(grant, "grant_id");
      if (grantId.length === 0) {
        markRecoveryRequired(operationId, "rollback_grant_missing");
        continue;
      }
      const resumed = await experienceService.rollback({
        projection_id: source.projection_id,
        target_version: targetVersion,
        grant_id: grantId,
        now: input.now
      });
      if (!resumed.ok) {
        markRecoveryRequired(operationId, resumed.error.code);
        continue;
      }
      reconciled += 1;
    }
    return revOk({ scanned: rows.length, reconciled, recovery_required: recoveryRequired });
  };

  /* --------------------------- skills --------------------------- */

  const findProposal = async (id: string): Promise<Proposal | null> => {
    const direct = await repository.getProposal(id);
    if (direct !== null) return direct;
    if (id.startsWith("wi:")) {
      const row = one<SqlRow>(connection, "SELECT candidate_id FROM write_intent WHERE write_id = :id", { id });
      if (row !== null) {
        return repository.getProposal(stringField(row, "candidate_id"));
      }
    }
    return null;
  };

  const findProjection = async (id: string): Promise<ExperienceProjection | null> => {
    if (id.startsWith("wi:")) {
      return repository.getProjectionByWriteId(id);
    }
    const direct = await repository.getProjection(id);
    if (direct !== null) return direct;
    return null;
  };

  const skillDiff = async (input: { id: string }): Promise<RevResult<SkillDiffView>> => {
    if (!reviewSchemaReady) {
      return revErr(revError("E_STORAGE_UNAVAILABLE", "skills_diff", "review_schema_missing"));
    }
    const proposal = await findProposal(input.id);
    if (proposal !== null) {
      const parsed = parseSourceRef(proposal.diff.ref);
      let text: string | undefined;
      if (parsed.ok && parsed.value.scheme === "blob") {
        const bytes = blobStore.read(parsed.value.locator as Hash);
        if (bytes.ok && parsed.value.end <= bytes.value.byteLength) {
          text = new TextDecoder().decode(bytes.value.subarray(parsed.value.start, parsed.value.end));
        }
      }
      return revOk({
        status: "ok",
        id: input.id,
        kind: "proposal",
        state: proposal.state,
        diff_format: proposal.diff.format,
        diff_ref: proposal.diff.ref,
        diff_hash: proposal.diff.hash,
        ...(text === undefined ? {} : { diff: text }),
        target_object_type: proposal.target.object_type,
        target_path_or_block: proposal.target.path_or_block,
        experience_id: proposal.experience.experience_id
      });
    }
    const projection = await findProjection(input.id);
    if (projection !== null) {
      return revOk({
        status: "ok",
        id: input.id,
        kind: "projection",
        state: projection.lifecycle,
        target_object_type: projection.object_type,
        target_path_or_block: projection.path_or_block,
        experience_id: projection.experience_id
      });
    }
    return revErr(revError("E_WRITE_NOT_FOUND", "skills_diff", "id_not_found"));
  };

  const skillRevoke = async (input: {
    id: string;
    actor?: "user" | "authorization_owner";
  }): Promise<RevResult<SkillRevokeView>> => {
    if (!reviewSchemaReady) {
      return revErr(revError("E_STORAGE_UNAVAILABLE", "skills_revoke", "review_schema_missing"));
    }
    const projection = await findProjection(input.id);
    if (projection !== null) {
      const revoked = await experienceService.revoke({
        projection_id: projection.projection_id,
        actor: input.actor ?? "user",
        now: now()
      });
      if (!revoked.ok) return revoked;
      return revOk({
        status: revoked.value.lifecycle === "revoked" ? "revoked" : "disabled",
        id: input.id,
        kind: "projection",
        lifecycle: revoked.value.lifecycle,
        row_version: revoked.value.row_version
      });
    }
    const proposal = await findProposal(input.id);
    if (proposal !== null) {
      if (proposal.state === "adopted") {
        return revErr(revError("E_PROPOSAL_ILLEGAL_TRANSITION", "skills_revoke", "adopted"));
      }
      const next: Proposal = {
        ...proposal,
        state: "withdrawn",
        updated_at: now(),
        version: proposal.version + 1
      };
      const saved = await write.saveProposal(next, proposal.version);
      if (!saved.ok) return revErr(revErrFromEnvelope(saved.error));
      return revOk({
        status: "withdrawn",
        id: input.id,
        kind: "proposal",
        state: next.state,
        row_version: next.version
      });
    }
    return revErr(revError("E_WRITE_NOT_FOUND", "skills_revoke", "id_not_found"));
  };

  const skillResolve = async (input: { id: string }): Promise<RevResult<SkillResolveView>> => {
    if (!reviewSchemaReady) {
      return revErr(revError("E_STORAGE_UNAVAILABLE", "skills_resolve", "review_schema_missing"));
    }
    const proposal = await findProposal(input.id);
    const writeId = proposal !== null
      ? (() => {
          const row = one<SqlRow>(
            connection,
            "SELECT write_id FROM write_intent WHERE candidate_id = :id ORDER BY created_at DESC LIMIT 1",
            { id: proposal.proposal_id }
          );
          const value = row === null ? null : row["write_id"];
          return typeof value === "string" ? value : undefined;
        })()
      : undefined;
    const resolvedWriteId = writeId ?? (input.id.startsWith("wi:") ? input.id : undefined);
    if (resolvedWriteId === undefined) {
      if (proposal !== null) {
        return revOk({
          status: "no_conflict",
          id: input.id,
          kind: "proposal",
          proposal_id: proposal.proposal_id
        });
      }
      const projection = await findProjection(input.id);
      if (projection !== null) {
        return revOk({
          status: "no_conflict",
          id: input.id,
          kind: "projection",
          proposal_id: projection.adoption_binding.proposal_id
        });
      }
      return revErr(revError("E_WRITE_NOT_FOUND", "skills_resolve", "id_not_found"));
    }
    const writeRow = one<SqlRow>(
      connection,
      `SELECT write_id, state FROM write_intent WHERE write_id = :id`,
      { id: resolvedWriteId }
    );
    const resultRow = one<SqlRow>(
      connection,
      `SELECT three_way_diff_ref, state FROM write_result
        WHERE write_id = :id ORDER BY attempt DESC LIMIT 1`,
      { id: resolvedWriteId }
    );
    const diffRef = resultRow === null ? null : validRef(nullableString(resultRow, "three_way_diff_ref"));
    if (diffRef === null) {
      return revOk({
        status: "no_conflict",
        id: input.id,
        kind: "write",
        write_id: resolvedWriteId,
        ...(writeRow === null ? {} : { write_state: stringField(writeRow, "state") }),
        ...(proposal === null ? {} : { proposal_id: proposal.proposal_id })
      });
    }
    let diff: string | undefined;
    const parsed = parseSourceRef(diffRef);
    if (parsed.ok && parsed.value.scheme === "blob") {
      const bytes = blobStore.read(parsed.value.locator as Hash);
      if (bytes.ok && parsed.value.end <= bytes.value.byteLength) {
        diff = new TextDecoder().decode(bytes.value.subarray(parsed.value.start, parsed.value.end));
      }
    }
    return revOk({
      status: "pending_manual_merge",
      id: input.id,
      kind: "write",
      write_id: resolvedWriteId,
      ...(writeRow === null ? {} : { write_state: stringField(writeRow, "state") }),
      ...(proposal === null ? {} : { proposal_id: proposal.proposal_id }),
      three_way_diff_ref: diffRef,
      ...(diff === undefined ? {} : { three_way_diff: diff }),
      options: ["discard", "regenerate", "manual_merge", "recheck"]
    });
  };

  return {
    repository,
    write,
    scheduler,
    review,
    experience: experienceService,
    worker,
    generation,
    journal_owned: journalOwned,
    dispose,
    resolveTask,
    enqueueReview,
    skillDiff,
    skillRevoke,
    skillResolve,
    reconcileExperienceRollbacks
  };
}

/** Alias used by the app-kernel composition root. */
export function createKernelReviewServices(options: ReviewServiceOptions): KernelReviewServices {
  return createReviewService(options);
}
