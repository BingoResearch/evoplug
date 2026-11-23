/**
 * REV service interfaces and default orchestration (DD-REV-140).
 *
 * Methods prepare the deterministic decision outside the FND writer lock and
 * then delegate the synchronous admission and frozen-frame commit to an
 * injected commit adapter. No method opens a second SQLite connection.
 */

import { canonicalJson, hashBytes, newId, toJsonValue } from "@evoplug/core";
import type { Clock, ErrorEnvelope, Hash, Id, Result, SourceRef } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ConfigVersionReadPort, GoalVersionReadPort } from "@evoplug/core";

import { type ClaimQuota, acceptFencingError, buildBudgetClaimRequest, buildBudgetReserveRequest, buildQueuedAttempt, computeClaimQuota, createLease, LEASE_DEFAULTS, markAttemptTerminal, refreshLease, heartbeatAllowed, type LeaseTimings } from "./attempt.js";
import type { BudgetLedgerPort } from "./budget-contracts.js";
import { mapHostAdapterError, outputReadMismatch } from "./errors.js";
import { canonicalRevCode, isRevRegistryCode, revErrorRow } from "./error-registry.js";
import type { GeneratorInput } from "./generator.js";
import type { ReviewAttempt } from "./types.js";
import {
  aggregateJobResult,
  canRetryWithinJob,
  claimBlockedDecision as claimDecision,
  markJobCancelled,
  markJobFailed,
  markJobStale,
  selectStaleTransition
} from "./job.js";
import type { JudgeService, QuestionPlanner } from "./judge-contracts.js";

import { buildHandoff, validateHandoff } from "./handoff.js";
import type { ReviewHandoffReadPort } from "./handoff.js";
import type { ReviewJob, ReviewSnapshot } from "./types.js";
import {
  isSnapshotValid,
  type SnapshotValidityPorts
} from "./snapshot.js";
import type {
  ExperienceProjection,
  Proposal,
  ProposalCandidateRecord,
  ReviewHandoff,
  ValidationPlan,
  Experience,
  UsageVerificationRecord
} from "./types.js";
import type {
  ReviewRepository,
  ReviewWritePort
} from "./ports.js";
import type { RecordUsageInput } from "./experience-service.js";

export interface RevError {
  code: string;
  retryable: boolean;
  stage: string;
  detail_ref?: SourceRef;
  cause?: string;
}

export type RevResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RevError };

export function revOk<T>(value: T): RevResult<T> {
  return { ok: true, value };
}

export function revErr<T>(error: RevError): RevResult<T> {
  return { ok: false, error };
}

export function revErrorFromEnvelope(error: ErrorEnvelope, cause?: string): RevError {
  const result: RevError = {
    code: error.code,
    retryable: error.retryable,
    stage: error.stage
  };
  if (error.detail_ref !== undefined) result.detail_ref = error.detail_ref;
  if (cause !== undefined) result.cause = cause;
  return result;
}

export function revErrorFromCode(code: string, stage: string, retryable: boolean): RevError {
  return { code, retryable, stage };
}

/* ------------------------------------------------------------------ */
/* Public interfaces                                                   */
/* ------------------------------------------------------------------ */

export interface ClaimedAttempt {
  attempt: ReviewAttempt;
  job: ReviewJob;
  input: GeneratorInput;
}

export interface ReviewService {
  getSnapshot(input: { snapshot_id: string }): Promise<RevResult<ReviewSnapshot>>;
  getJob(input: { job_id: string }): Promise<RevResult<ReviewJob>>;
  claimNextAttempt(input: { worker_id: string; now: number }): Promise<RevResult<ClaimedAttempt | null>>;
  heartbeat(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    now: number;
  }): Promise<RevResult<{ expires_at: number }>>;
  acceptOutput(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; attempt: ReviewAttempt; candidates: ProposalCandidateRecord[] }>>;
  failAttempt(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    error: RevError;
    now: number;
  }): Promise<RevResult<ReviewAttempt>>;
  cancelJob(input: {
    job_id: string;
    actor: "user" | "system";
    reason: string;
    now: number;
  }): Promise<RevResult<{
    job: ReviewJob;
    attempt_cancellation: "requested" | "not_running" | "unsupported";
  }>>;
  recoverExpired(input: {
    now: number;
    worker_id: string;
  }): Promise<RevResult<{ lost: string[]; requeued: string[]; failed: string[] }>>;
  runStaticCheck(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; candidates: ProposalCandidateRecord[]; proposals: Proposal[] }>>;
  runMatchJudge(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; proposals: Proposal[] }>>;
  finalizeHandoff(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; handoff: ReviewHandoff; proposals: Proposal[] }>>;
  listAdoptable(input: {
    job_id: string;
  }): Promise<RevResult<Array<{ proposal: Proposal; handoff: ReviewHandoff; auto_adopt_eligible: boolean }>>>;
}

export interface ReviewScheduler {
  prepareEnqueue(input: {
    schema_version: "rsi.prepare_review_enqueue_in/1";
    req: import("./host-contracts.js").ReviewEnqueueRequest;
    trigger: import("./host-contracts.js").TriggerEvent;
  }): Promise<import("./types.js").PreparedReviewEnqueue>;
  enqueueInTransaction(
    stage: import("./ports.js").LiveCommitStage,
    req: import("./host-contracts.js").ReviewEnqueueRequest,
    prepared: import("./types.js").PreparedReviewEnqueue
  ): import("./host-contracts.js").ReviewEnqueueResult;
}

export interface ExperienceService {
  recordAdoption(input: {
    proposal_id: string;
    write_id: string;
    grant_id: string;
    now: number;
  }): Promise<RevResult<ExperienceProjection>>;
  beginTrial(input: { projection_id: string; now: number }): Promise<RevResult<ExperienceProjection>>;
  recordUsage(input: RecordUsageInput): Promise<RevResult<UsageVerificationRecord>>;
  evaluateLifecycle(input: {
    projection_id: string;
    now: number;
  }): Promise<RevResult<{ projection: ExperienceProjection; event: import("./types.js").ExperienceLifecycleEvent }>>;
  extendWindow(input: { projection_id: string; now: number }): Promise<RevResult<ExperienceProjection>>;
  revoke(input: {
    projection_id: string;
    actor: "user" | "authorization_owner";
    now: number;
  }): Promise<RevResult<ExperienceProjection>>;
  rollback(input: {
    projection_id: string;
    target_version: number;
    grant_id: string;
    now: number;
  }): Promise<RevResult<{ projection: ExperienceProjection; write_id: string }>>;
}

/* ------------------------------------------------------------------ */
/* Commit adapter                                                      */
/* ------------------------------------------------------------------ */

export interface AcceptanceCommitInput {
  attempt: ReviewAttempt;
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  output_bytes: Uint8Array;
  now: number;
}

export interface StaticCheckCommitInput {
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  candidates: ProposalCandidateRecord[];
  checked: Array<{
    candidate_key: Hash;
    proposal?: Proposal;
    experience?: Experience;
    validation_plan?: ValidationPlan;
    failure?: { code: string; step: string; detail_ref: SourceRef };
  }>;
  now: number;
}

export interface JudgeCommitInput {
  job: ReviewJob;
  proposals: Proposal[];
  now: number;
}

export interface HandoffCommitInput {
  job: ReviewJob;
  snapshot: ReviewSnapshot;
  handoff: ReviewHandoff;
  proposals: Proposal[];
  now: number;
}

export interface ReviewServiceDeps {
  repo: ReviewRepository;
  write: ReviewWritePort;
  budget: BudgetLedgerPort;
  generation: import("./host-contracts.js").HostGenerationPort;
  /**
   * Read-only approved backend ids from FND configuration. The secret
   * reference is not an approval and is never used as one here.
   */
  approvedBackendIds?: readonly string[];
  sourceBytes: import("./ports.js").SourceBytesPort;
  goal: GoalVersionReadPort;
  config: ConfigVersionReadPort;
  clock: Clock;
  policySupported(policyVersion: string): boolean;
  outputPolicy: import("./types.js").ReviewOutputPolicySource;
  buildAttempt(
    input: {
      job: ReviewJob;
      snapshot: ReviewSnapshot;
      backend: Extract<import("./host-contracts.js").GenerationBackendSelection, { state: "available" }>;
      quota: ClaimQuota;
      attempt_id: Id<"rat">;
      now: number;
      worker_id: string;
    }
  ): Result<
    {
      backend: import("./host-contracts.js").GenerationBackendRef;
      model_id: string;
      host_run: ReviewAttempt["host_run"];
      isolation: ReviewAttempt["isolation"];
      input_manifest_ref: SourceRef;
      input_manifest_hash: Hash;
      output_ref: SourceRef;
    },
    ErrorEnvelope
  >;
  buildGeneratorInput(input: {
    job: ReviewJob;
    attempt: ReviewAttempt;
    snapshot: ReviewSnapshot;
  }): Result<GeneratorInput, ErrorEnvelope>;
  acceptanceCommit(input: AcceptanceCommitInput): Promise<Result<
    { job: ReviewJob; attempt: ReviewAttempt; candidates: ProposalCandidateRecord[] },
    ErrorEnvelope
  >>;
  staticCheckCommit(input: StaticCheckCommitInput): Promise<Result<
    { job: ReviewJob; candidates: ProposalCandidateRecord[]; proposals: Proposal[] },
    ErrorEnvelope
  >>;
  judgeCommit(input: JudgeCommitInput): Promise<Result<
    { job: ReviewJob; proposals: Proposal[] },
    ErrorEnvelope
  >>;
  handoffCommit(input: HandoffCommitInput): Promise<Result<
    { job: ReviewJob; handoff: ReviewHandoff; proposals: Proposal[] },
    ErrorEnvelope
  >>;
  staticCheckContext(input: {
    job: ReviewJob;
    snapshot: ReviewSnapshot;
    attempt: ReviewAttempt;
    now: number;
  }): Promise<Result<import("./static-check.js").StaticCheckContext, ErrorEnvelope>>;
  planner: QuestionPlanner;
  judge: JudgeService;
  judgeDispatch: {
    dispatch(input: {
      job: ReviewJob;
      snapshot: ReviewSnapshot;
      proposal: Proposal;
      now: number;
    }): Promise<Result<Proposal, ErrorEnvelope>>;
  };
  handoffRead: ReviewHandoffReadPort;
  leaseTimings?: LeaseTimings;
}

/* ------------------------------------------------------------------ */
/* Default service                                                     */
/* ------------------------------------------------------------------ */

/**
 * An attempt whose process identity cannot be confirmed. The platform must
 * supply a start token; a pid alone is never enough to kill or retry
 * (DD-REV-032).
 */
function attemptIsOrphan(attempt: ReviewAttempt): boolean {
  const processRef = attempt.lease?.process_ref;
  if (processRef === undefined) {
    // The platform did not supply a process start token, so the process
    // identity cannot be confirmed. The pid alone is never enough to kill
    // or retry the attempt.
    return attempt.lease !== undefined;
  }
  return processRef.start_token.length === 0;
}

/**
 * Retry boundary for a lost attempt (DD-REV-032 recovery matrix). A lost
 * attempt is requeued only when its error is retryable; the registry fixes
 * the default per code.
 */
function attemptIsRetryable(attempt: ReviewAttempt): boolean {
  const code = attempt.last_error?.code;
  if (code === undefined) {
    return true;
  }
  const canonical = canonicalRevCode(code);
  if (!isRevRegistryCode(canonical)) {
    return false;
  }
  return revErrorRow(canonical).retryable_default;
}

/** Terminal reason for a lost attempt that must not be retried. */
function attemptTerminalReason(attempt: ReviewAttempt): string {
  const code = attempt.last_error?.code;
  if (code === undefined) {
    return "E_REVIEW_LEASE_EXPIRED";
  }
  return canonicalRevCode(code);
}

export class DefaultReviewService implements ReviewService {
  private readonly deps: ReviewServiceDeps;

  constructor(deps: ReviewServiceDeps) {
    this.deps = deps;
  }

  async getSnapshot(input: { snapshot_id: string }): Promise<RevResult<ReviewSnapshot>> {
    const snapshot = await this.deps.repo.getSnapshot(input.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "read", false));
    }
    return revOk(snapshot);
  }

  async getJob(input: { job_id: string }): Promise<RevResult<ReviewJob>> {
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_REVIEW_TRIGGER_INVALID", "read", false));
    }
    return revOk(job);
  }

  async claimNextAttempt(input: { worker_id: string; now: number }): Promise<RevResult<ClaimedAttempt | null>> {
    const job = await this.deps.repo.findClaimableJob(input.now);
    if (job === null) {
      return revOk(null);
    }
    if (job.retry_after_at !== undefined && job.retry_after_at > input.now) {
      return revOk(null);
    }
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_validate", false));
    }
    const validity = await isSnapshotValid(snapshot, input.now, this.validityPorts(job));
    if (!validity.ok) {
      return revErr(revErrorFromEnvelope(validity.error));
    }
    if (!validity.value.valid) {
      const selection = selectStaleTransition({
        supersededByJobId: job.superseded_by_job_id ?? null,
        staleReason: validity.value.stale_reason
      });
      const stale = markJobStale(job, {
        reason: selection.kind === "superseded" ? "superseded" : selection.reason,
        now: input.now,
        cancelActiveAttempt: true,
        jobResultTransitionId: selection.kind === "superseded" ? "J14" : "J15"
      });
      const saved = await this.deps.write.saveJob(stale, job.version);
      if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
      return revOk(null);
    }

    const backendRequest = {
      job_id: job.job_id,
      review_scope_key: job.review_scope_key,
      host_binding: snapshot.host_event.binding,
      approved_backend_ids: [...(this.deps.approvedBackendIds ?? [])],
      required_isolation: "process" as const,
      required_network: "disabled" as const,
      budget_policy_ref: job.budget_policy_ref,
      capability_policy_ref: "capability/default",
      deadline_ms: input.now + snapshot.budget.wall_ms
    };
    const selection = await this.deps.generation.selectBackend(
      backendRequest,
      AbortSignal.timeout(Math.max(1, snapshot.budget.wall_ms))
    );
    if (!selection.ok) {
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(`${JSON.stringify({ message: "debug.select_backend_failed", job_id: job.job_id, error: selection.error })}\n`);
      }
      return revErr(
        revErrorFromEnvelope(
          mapHostAdapterError(selection.error, selection.error.details_ref)
        )
      );
    }
    if (selection.value.state === "blocked_no_backend") {
      const blocked: ReviewJob = {
        ...job,
        state: "blocked_no_backend",
        stage: "generate",
        block_reason: selection.value.reason,
        backend: {
          ...job.backend,
          selection_ref: backendSelectionRef(selection.value),
          missing_capabilities: selection.value.missing.map((item) => ({ ...item })),
          cancellation: "blocked",
          recovery: "blocked"
        },
        version: job.version + 1,
        updated_at: input.now
      };
      const saved = await this.deps.write.saveJob(blocked, job.version);
      if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
      return revOk(null);
    }
    const unavailable = requiredCapabilitiesMissing(selection.value);
    if (unavailable !== null) {
      const blocked: ReviewJob = {
        ...job,
        state: "blocked_no_backend",
        stage: "generate",
        block_reason: unavailable.reason,
        backend: {
          ...job.backend,
          selection_ref: backendSelectionRef(selection.value),
          missing_capabilities: unavailable.missing,
          cancellation: "blocked",
          recovery: "blocked"
        },
        version: job.version + 1,
        updated_at: input.now
      };
      const saved = await this.deps.write.saveJob(blocked, job.version);
      if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
      return revOk(null);
    }

    const quota = computeClaimQuota({
      budget: snapshot.budget,
      unknown_usage: job.allowance_charge.unknown_usage,
      input_tokens_charged: job.allowance_charge.input_tokens_charged ?? 0,
      output_tokens_charged: job.allowance_charge.output_tokens_charged ?? 0,
      now: input.now
    });
    if (quota.kind !== "claimed") {
      const failed = markJobFailed(job, "E_REVIEW_BUDGET_EXHAUSTED", input.now);
      const saved = await this.deps.write.saveJob(failed, job.version);
      if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
      return revOk(null);
    }

    const attemptId = newId("rat");
    const environment = this.deps.buildAttempt({
      job,
      snapshot,
      backend: selection.value,
      quota: quota.quota,
      attempt_id: attemptId,
      now: input.now,
      worker_id: input.worker_id
    });
    if (!environment.ok) {
      return revErr(revErrorFromEnvelope(environment.error));
    }
    const attempt = buildQueuedAttempt({
      attempt_id: attemptId,
      job,
      snapshot_hash: job.snapshot_hash,
      quota: quota.quota,
      backend: environment.value.backend,
      model_id: environment.value.model_id,
      host_run: environment.value.host_run,
      isolation: environment.value.isolation,
      input_manifest_ref: environment.value.input_manifest_ref,
      input_manifest_hash: environment.value.input_manifest_hash,
      output_ref: environment.value.output_ref,
      created_at: input.now
    });
    const savedAttempt = await this.deps.write.saveAttempt(attempt, 0);
    if (!savedAttempt.ok) return revErr(revErrorFromEnvelope(savedAttempt.error));

    const reserve = await this.deps.budget.reserve(
      buildBudgetReserveRequest({
        job,
        attemptKey: attempt.attempt_key,
        stableWatermark: job.stable_watermark,
        quota: quota.quota,
        serviceProfile: {
          service_profile_id: selection.value.service_profile.service_profile_id,
          service_profile_key: selection.value.service_profile.service_profile_key,
          provider_scope: selection.value.service_profile.provider_scope,
          limits: selection.value.service_profile.limits,
          evidence_ref: selection.value.service_profile.evidence_ref
        }
      })
    );
    if (!reserve.ok) {
      const failed = markAttemptTerminal({
        attempt,
        state: "failed",
        now: input.now,
        error: {
          code: reserve.error.code,
          ...(reserve.error.code === "E_BUDGET" ? { reason_code: "pricing_unknown" } : {}),
          stage: reserve.error.stage ?? "budget.reserve",
          ...(reserve.error.message_key === undefined ? {} : { message: reserve.error.message_key })
        }
      });
      await this.deps.write.saveAttempt(failed, attempt.row_version);
      // Appendix F.7: every terminal failure carries a category code, reason
      // and stage that `evolve status` can read. Leaving the job queued would
      // hide a permanent budget failure behind a retry loop.
      const failedJob = markJobFailed(job, reserve.error.code, input.now, {
        code: reserve.error.code,
        ...(reserve.error.code === "E_BUDGET" ? { reason_code: "pricing_unknown" } : {}),
        stage: reserve.error.stage ?? "budget.reserve",
        ...(reserve.error.message_key === undefined ? {} : { message: reserve.error.message_key })
      });
      await this.deps.write.saveJob(failedJob, job.version);
      return revErr(revErrorFromEnvelope(reserve.error));
    }
    const claim = await this.deps.budget.claim(
      buildBudgetClaimRequest({
        reservationId: reserve.value.reservation_id,
        attemptKey: attempt.attempt_key,
        quota: quota.quota
      })
    );
    if (!claim.ok) {
      return revErr(revErrorFromEnvelope(claim.error));
    }
    if (claim.value.state === "blocked") {
      const decision = claimDecision(claim.value.reason_code, claim.value.retry_after_ms);
      const profile = selection.value.service_profile;
      const pricing =
        profile.limits.source === "verified_profile"
          ? profile.limits.pricing.status
          : profile.limits.reason_code;
      const diagnostic = {
        reason_code: claim.value.reason_code,
        stage: "budget.claim",
        message: `budget claim blocked: ${claim.value.reason_code} (pricing=${pricing}, provider_scope=${profile.provider_scope})`
      };
      await this.deps.budget.settle({
        reservation_id: reserve.value.reservation_id,
        outcome: "not_sent",
        provider_usage: null
      });
      const failedAttempt = markAttemptTerminal({
        attempt,
        state: "failed",
        now: input.now,
        error: diagnostic
      });
      await this.deps.write.saveAttempt(failedAttempt, attempt.row_version);
      // The blocked claim already wrote attempt `ordinal = attempt_count+1`.
      // That attempt is consumed at claim time, so every outcome advances the
      // count; otherwise the next claim reuses the ordinal and the attempt
      // insert violates (job_id, ordinal), which fences the journal era.
      const consumed: ReviewJob = {
        ...job,
        attempt_count: job.attempt_count + 1,
        version: job.version + 1,
        updated_at: input.now
      };
      let nextJob: ReviewJob = consumed;
      if (decision.job_transition === "J16") {
        const terminal = decision.terminal_reason ?? "E_REVIEW_BUDGET_EXHAUSTED";
        nextJob = {
          ...markJobFailed(job, terminal, input.now, {
            ...(terminal.startsWith("E_") ? { code: terminal } : {}),
            ...diagnostic
          }),
          attempt_count: consumed.attempt_count
        };
      } else if (decision.job_transition === "J2") {
        nextJob = {
          ...consumed,
          state: "blocked_no_backend",
          stage: "generate",
          block_reason: decision.block_reason ?? "budget_unavailable"
        };
      } else {
        // `stay_queued`: concurrency/rate pressure has no explicit retry time
        // in the budget layer, so use a short backoff instead of a hot loop.
        nextJob = {
          ...consumed,
          state: "queued",
          retry_after_at: input.now + (decision.retry_after_ms ?? 1000)
        };
      }
      await this.deps.write.saveJob(nextJob, job.version);
      return revOk(null);
    }

    const lease = createLease({
      leaseId: `lease:${attempt.attempt_id}:${String(input.now)}`,
      ownerId: input.worker_id,
      fencingToken: job.current_fencing_token + 1,
      now: input.now,
      timings: this.deps.leaseTimings ?? LEASE_DEFAULTS
    });
    const leased = {
      ...attempt,
      state: "leased" as const,
      lease,
      deadline_at: claim.value.effective_deadline_ms,
      budget: {
        ...attempt.budget,
        reservation_id: reserve.value.reservation_id,
        attempt_charge_id: claim.value.attempt_charge_id,
        state: "claimed" as const
      },
      row_version: attempt.row_version + 1,
      updated_at: input.now
    };
    const generating: ReviewJob = {
      ...job,
      state: "generating",
      stage: "generate",
      active_attempt_id: attempt.attempt_id,
      current_fencing_token: lease.fencing_token,
      attempt_count: job.attempt_count + 1,
      backend: {
        ...job.backend,
        selection_ref: backendSelectionRef(selection.value),
        backend_id: selection.value.backend.backend_id,
        backend_kind: selection.value.backend.backend_kind,
        capability_snapshot_hash: selection.value.backend.capability_snapshot_hash,
        service_profile: {
          service_profile_id: selection.value.service_profile.service_profile_id,
          service_profile_key: selection.value.service_profile.service_profile_key,
          provider_scope: selection.value.service_profile.provider_scope,
          limits: selection.value.service_profile.limits,
          evidence_ref: selection.value.service_profile.evidence_ref
        },
        cancellation: selection.value.backend.capabilities.cancel.status === "verified" ? "verified" : "blocked",
        recovery: selection.value.backend.capabilities.recover.status === "verified" ? "verified" : "blocked"
      },
      version: job.version + 1,
      updated_at: input.now
    };
    delete generating.block_reason;
    const savedLease = await this.deps.write.saveAttempt(leased, attempt.row_version);
    if (!savedLease.ok) return revErr(revErrorFromEnvelope(savedLease.error));
    const savedJob = await this.deps.write.saveJob(generating, job.version);
    if (!savedJob.ok) return revErr(revErrorFromEnvelope(savedJob.error));
    const generatorInput = this.deps.buildGeneratorInput({ job: generating, attempt: leased, snapshot });
    if (!generatorInput.ok) return revErr(revErrorFromEnvelope(generatorInput.error));
    return revOk({ attempt: leased, job: generating, input: generatorInput.value });
  }

  async heartbeat(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    now: number;
  }): Promise<RevResult<{ expires_at: number }>> {
    const attempt = await this.deps.repo.getAttempt(input.attempt_id);
    if (attempt === null) {
      return revErr(revErrorFromCode("E_REVIEW_LEASE_EXPIRED", "lease", true));
    }
    const job = await this.deps.repo.getJob(attempt.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_REVIEW_LEASE_EXPIRED", "lease", true));
    }
    const allowed = heartbeatAllowed({
      attempt,
      job,
      now: input.now,
      lease_id: input.lease_id,
      fencing_token: input.fencing_token
    });
    if (!allowed.ok) {
      return revErr(revErrorFromEnvelope(allowed.error));
    }
    const lease = refreshLease({
      lease: attempt.lease ?? {
        lease_id: input.lease_id,
        owner_id: "unknown",
        fencing_token: input.fencing_token,
        acquired_at: input.now,
        heartbeat_at: input.now,
        expires_at: input.now
      },
      now: input.now,
      timings: this.deps.leaseTimings ?? LEASE_DEFAULTS
    });
    const next: ReviewAttempt = {
      ...attempt,
      lease,
      row_version: attempt.row_version + 1,
      updated_at: input.now
    };
    const saved = await this.deps.write.saveAttempt(next, attempt.row_version);
    if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
    return revOk({ expires_at: lease.expires_at });
  }

  async acceptOutput(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; attempt: ReviewAttempt; candidates: ProposalCandidateRecord[] }>> {
    const attempt = await this.deps.repo.getAttempt(input.attempt_id);
    if (attempt === null) {
      return revErr(revErrorFromCode("E_REVIEW_FENCING_STALE", "accept_output", false));
    }
    // T3 is idempotent: an attempt that already has an acceptance point
    // returns the existing result and writes nothing.
    const existingAcceptance =
      typeof this.deps.repo.getAcceptance === "function"
        ? await this.deps.repo.getAcceptance(input.attempt_id)
        : null;
    if (existingAcceptance !== null) {
      const existingJob = await this.deps.repo.getJob(existingAcceptance.job_id);
      if (existingJob !== null) {
        // The reservation must be released even on the idempotent replay: a
        // successful attempt otherwise keeps its concurrency slot claimed and
        // later jobs can never pass `concurrency_limited`.
        await this.releaseSucceededReservation(attempt);
        const existingCandidates = await this.deps.repo.getCandidates(existingJob.job_id);
        return revOk({
          job: existingJob,
          attempt,
          candidates: existingCandidates
        });
      }
    }
    const job = await this.deps.repo.getJob(attempt.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_REVIEW_FENCING_STALE", "accept_output", false));
    }
    if (attempt.state !== "leased" && attempt.state !== "running") {
      return revErr(
        revErrorFromCode("E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION", "accept_output", false)
      );
    }
    const fencing = acceptFencingError({
      attempt,
      job,
      lease_id: input.lease_id,
      fencing_token: input.fencing_token,
      now: input.now
    });
    if (fencing !== null) {
      return revErr(revErrorFromEnvelope(fencing));
    }
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "accept_output", false));
    }
    const bytes = await this.deps.sourceBytes.read(attempt.output_ref);
    if (!bytes.ok) {
      return revErr(revErrorFromEnvelope(bytes.error));
    }
    // DD-REV-041: the canonical file and the chunked `readOutput` bytes
    // must produce the same hash. A mismatch is refused before any
    // acceptance point, candidate or Proposal is written.
    // DD-REV-041: the chunked `readOutput` hash and the canonical file
    // hash must agree. `attempt.output.hash` is the hash the backend
    // reported for the chunked read; the bytes read from `output_ref` are
    // the canonical file. A mismatch is refused before any acceptance
    // point, candidate or Proposal is written.
    const fileHash = hashBytes(bytes.value);
    const declared = attempt.output?.hash;
    if (declared !== undefined && declared !== fileHash) {
      return revErr(outputReadMismatch(declared, fileHash));
    }
    const committed = await this.deps.acceptanceCommit({
      attempt,
      job,
      snapshot,
      output_bytes: bytes.value,
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    await this.releaseSucceededReservation(attempt);
    return revOk(committed.value);
  }

  /**
   * Settles the claim-time reservation of a successful attempt. Without this
   * the reservation stays `claimed` forever: the budget layer counts it as an
   * in-flight slot, so a later review hits `concurrency_limited` and retries
   * until the attempt-ordinal CHECK fences the journal.
   */
  private async releaseSucceededReservation(attempt: ReviewAttempt): Promise<void> {
    const reservationId = attempt.budget.reservation_id;
    if (reservationId === undefined) return;
    await this.deps.budget.settle({
      reservation_id: reservationId,
      outcome: "succeeded",
      provider_usage: null
    });
  }

  async failAttempt(input: {
    attempt_id: string;
    lease_id: string;
    fencing_token: number;
    error: RevError;
    now: number;
  }): Promise<RevResult<ReviewAttempt>> {
    const attempt = await this.deps.repo.getAttempt(input.attempt_id);
    if (attempt === null) {
      return revErr(revErrorFromCode("E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION", "attempt_transition", false));
    }
    const job = await this.deps.repo.getJob(attempt.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION", "attempt_transition", false));
    }
    if (
      attempt.lease === undefined ||
      attempt.lease.lease_id !== input.lease_id ||
      attempt.lease.fencing_token !== input.fencing_token
    ) {
      return revErr(revErrorFromCode("E_REVIEW_FENCING_STALE", "accept_output", false));
    }
    const failed = markAttemptTerminal({
      attempt,
      state: "failed",
      now: input.now,
      error: {
        code: input.error.code,
        stage: input.error.stage ?? "generate",
        ...(input.error.cause === undefined ? {} : { message: input.error.cause }),
        ...(input.error.detail_ref === undefined ? {} : { detail_ref: input.error.detail_ref })
      }
    });
    const settle = await this.settleAttempt(attempt, job, "failed");
    if (!settle.ok) {
      return revErr(revErrorFromEnvelope(settle.error));
    }
    const saved = await this.deps.write.saveAttempt(failed, attempt.row_version);
    if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
    const maxAttempts = await this.maxAttemptsFor(job);
    const retryable = input.error.retryable && canRetryWithinJob(settle.value, maxAttempts);
    let nextJob = job;
    if (retryable) {
      nextJob = {
        ...settle.value,
        state: "queued",
        stage: "generate",
        current_fencing_token: job.current_fencing_token + 1,
        version: job.version + 1,
        updated_at: input.now
      };
      delete nextJob.active_attempt_id;
    } else {
      nextJob = markJobFailed(settle.value, input.error.code, input.now);
    }
    const savedJob = await this.deps.write.saveJob(nextJob, job.version);
    if (!savedJob.ok) return revErr(revErrorFromEnvelope(savedJob.error));
    return revOk(failed);
  }

  async cancelJob(input: {
    job_id: string;
    actor: "user" | "system";
    reason: string;
    now: number;
  }): Promise<RevResult<{
    job: ReviewJob;
    attempt_cancellation: "requested" | "not_running" | "unsupported";
  }>> {
    void input.reason;
    void input.actor;
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    if (job.state === "stale" || job.state === "done" || job.state === "failed" || job.state === "cancelled") {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    let cancellation: "requested" | "not_running" | "unsupported" = "not_running";
    if (job.active_attempt_id !== undefined) {
      const attempt = await this.deps.repo.getAttempt(job.active_attempt_id);
      if (attempt !== null) {
        const cancelledAttempt: ReviewAttempt = {
          ...attempt,
          cancel: {
            ...attempt.cancel,
            requested_at: attempt.cancel.requested_at ?? input.now,
            mode: "cooperative"
          },
          row_version: attempt.row_version + 1,
          updated_at: input.now
        };
        const savedAttempt = await this.deps.write.saveAttempt(cancelledAttempt, attempt.row_version);
        if (!savedAttempt.ok) return revErr(revErrorFromEnvelope(savedAttempt.error));
        cancellation = attempt.state === "queued" && job.backend.cancellation === "blocked"
          ? "unsupported"
          : "requested";
      }
    }
    const next = markJobCancelled(job, input.now);
    const saved = await this.deps.write.saveJob(next, job.version);
    if (!saved.ok) return revErr(revErrorFromEnvelope(saved.error));
    return revOk({ job: next, attempt_cancellation: cancellation });
  }

  async recoverExpired(input: {
    now: number;
    worker_id: string;
  }): Promise<RevResult<{ lost: string[]; requeued: string[]; failed: string[] }>> {
    void input.worker_id;
    const expired = await this.deps.repo.listExpiredAttempts(input.now);
    const lost: string[] = [];
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const attempt of expired) {
      const job = await this.deps.repo.getJob(attempt.job_id);
      if (job === null) {
        continue;
      }
      // A terminal job is never resurrected by the recovery. `cancelled`,
      // `done`, `failed` and `stale` are terminal for every target state
      // (DD-REV-021); the attempt is closed without requeueing the job.
      if (
        job.state === "cancelled" ||
        job.state === "done" ||
        job.state === "failed" ||
        job.state === "stale"
      ) {
        const closedAttempt = markAttemptTerminal({
          attempt,
          state: job.state === "cancelled" ? "cancelled" : "lost",
          now: input.now,
          exit: { at: input.now, reason: "lease_lost" }
        });
        const savedAttempt = await this.deps.write.saveAttempt(closedAttempt, attempt.row_version);
        if (!savedAttempt.ok) return revErr(revErrorFromEnvelope(savedAttempt.error));
        lost.push(attempt.attempt_id);
        failed.push(attempt.attempt_id);
        continue;
      }
      const lostAttempt = markAttemptTerminal({
        attempt,
        state: "lost",
        now: input.now,
        exit: { at: input.now, reason: "lease_lost" }
      });
      const savedAttempt = await this.deps.write.saveAttempt(lostAttempt, attempt.row_version);
      if (!savedAttempt.ok) return revErr(revErrorFromEnvelope(savedAttempt.error));
      lost.push(attempt.attempt_id);
      const settled = await this.settleAttempt(attempt, job, "unknown");
      if (!settled.ok) {
        failed.push(attempt.attempt_id);
        continue;
      }
      const maxAttempts = await this.maxAttemptsFor(job);
      const attemptsExhausted = job.attempt_count >= maxAttempts;
      const unknownUsage = job.allowance_charge.unknown_usage;
      // DD-REV-032 recovery matrix: an orphan whose process identity cannot
      // be confirmed never retries and fails with `E_REVIEW_ORPHAN_UNKNOWN`.
      const orphan = attemptIsOrphan(attempt);
      const canRetry =
        !orphan &&
        !attemptsExhausted &&
        !unknownUsage &&
        attemptIsRetryable(attempt);
      const terminalReason = orphan
        ? "E_REVIEW_ORPHAN_UNKNOWN"
        : attemptsExhausted || unknownUsage
          ? "E_REVIEW_BUDGET_EXHAUSTED"
          : attemptTerminalReason(attempt);
      const nextJob = canRetry
        ? {
            ...settled.value,
            state: "queued" as const,
            stage: "generate" as const,
            current_fencing_token: job.current_fencing_token + 1,
            version: job.version + 1,
            updated_at: input.now
          }
        : markJobFailed(job, terminalReason, input.now);
      if (canRetry) {
        delete nextJob.active_attempt_id;
        requeued.push(attempt.attempt_id);
      } else {
        failed.push(attempt.attempt_id);
      }
      const savedJob = await this.deps.write.saveJob(nextJob, job.version);
      if (!savedJob.ok) return revErr(revErrorFromEnvelope(savedJob.error));
    }
    return revOk({ lost, requeued, failed });
  }

  async runStaticCheck(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; candidates: ProposalCandidateRecord[]; proposals: Proposal[] }>> {
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    if (!(job.state === "generating" && job.stage === "static_check")) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_validate", false));
    }
    const candidates = (await this.deps.repo.getCandidates(job.job_id)).filter(
      (candidate) => candidate.state === "pending"
    );
    const attempts = await this.deps.repo.listAttempts(job.job_id);
    const attempt = attempts.find((item) => item.state === "succeeded");
    if (attempt === undefined) {
      return revErr(revErrorFromCode("E_PROPOSAL_BINDING", "proposal_ingest", false));
    }
    const context = await this.deps.staticCheckContext({
      job,
      snapshot,
      attempt,
      now: input.now
    });
    if (!context.ok) {
      return revErr(revErrorFromEnvelope(context.error));
    }
    const { runStaticCheck } = await import("./static-check.js");
    const checked: StaticCheckCommitInput["checked"] = [];
    for (const candidate of [...candidates].sort((left, right) => left.ordinal - right.ordinal)) {
      const loaded = await this.deps.repo.getCandidateJson(candidate);
      if (loaded === null) {
        return revErr(revErrorFromCode("E_PROPOSAL_BINDING", "proposal_ingest", false));
      }
      const result = runStaticCheck({
        candidate_json: loaded,
        ordinal: candidate.ordinal,
        job_id: job.job_id,
        attempt_id: attempt.attempt_id,
        candidate_key: candidate.candidate_key,
        context: context.value
      });
      if (result.status === "accepted") {
        checked.push({
          candidate_key: candidate.candidate_key,
          proposal: result.proposal,
          experience: result.experience,
          validation_plan: result.validation_plan
        });
      } else {
        // Appendix F.7: the terminal candidate keeps the category code, stage
        // and the precise path/rule of the failed check. The frozen blob is
        // the diagnostic `evolve status` and `skills diff` read.
        const bytes = canonicalJson(
          toJsonValue({
            schema_version: "rsi.candidate_failure/1",
            code: result.failure.code,
            step: result.failure.step,
            path: result.failure.path,
            rule: result.failure.rule,
            recorded_at: input.now
          })
        );
        const frozen = context.value.materializeBlob(bytes);
        checked.push({
          candidate_key: candidate.candidate_key,
          failure: {
            code: result.failure.code,
            step: result.failure.step,
            detail_ref: frozen.ok
              ? frozen.value
              : `blob://sha256:0000000000000000000000000000000000000000000000000000000000000000#bytes=0-0`
          }
        });
      }
    }
    const committed = await this.deps.staticCheckCommit({
      job,
      snapshot,
      candidates,
      checked,
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async runMatchJudge(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; proposals: Proposal[] }>> {
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    if (job.stage !== "experience_match_judge") {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_validate", false));
    }
    const proposals = await this.deps.repo.listProposals(job.job_id);
    const updated: Proposal[] = [];
    for (const proposal of proposals) {
      if (proposal.match_judge.status !== "pending") {
        updated.push(proposal);
        continue;
      }
      const dispatched = await this.deps.judgeDispatch.dispatch({
        job,
        snapshot,
        proposal,
        now: input.now
      });
      if (!dispatched.ok) {
        return revErr(revErrorFromEnvelope(dispatched.error));
      }
      updated.push(dispatched.value);
    }
    const committed = await this.deps.judgeCommit({ job, proposals: updated, now: input.now });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async finalizeHandoff(input: {
    job_id: string;
    now: number;
  }): Promise<RevResult<{ job: ReviewJob; handoff: ReviewHandoff; proposals: Proposal[] }>> {
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    if (job.state !== "proposed") {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "handoff_finalize", false));
    }
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    if (snapshot === null) {
      return revErr(revErrorFromCode("E_REVIEW_SNAPSHOT_SOURCE_MISSING", "snapshot_validate", false));
    }
    const proposals = await this.deps.repo.listProposals(job.job_id);
    const handoffProposals = proposals.filter(
      (proposal) => proposal.state === "checked" || proposal.state === "unverified" || proposal.state === "proposed"
    );
    const candidates = await this.deps.repo.getCandidates(job.job_id);
    const jobResult = aggregateJobResult({
      handoffProposalCount: handoffProposals.length,
      candidateCount: candidates.length,
      rejectedCandidateCount: candidates.filter((candidate) => candidate.state === "rejected").length,
      staleCandidateCount: candidates.filter((candidate) => candidate.state === "stale").length,
      staleProposalCount: proposals.filter((proposal) => proposal.state === "stale").length,
      acceptedProposalCount: proposals.filter((proposal) => proposal.state === "checked" || proposal.state === "unverified").length
    });
    const handoff = buildHandoff({
      handoff_id: newId("hand"),
      job,
      snapshot,
      proposals: handoffProposals,
      stage_results: [
        { stage: "snapshot", status: "ok" },
        { stage: "generate", status: "ok" },
        { stage: "static_check", status: "ok" },
        {
          stage: "experience_match_judge",
          status: handoffProposals.some((proposal) => proposal.match_judge.status === "degraded")
            ? "degraded"
            : "skipped"
        },
        { stage: "handoff", status: "ok" }
      ],
      job_result: jobResult,
      auto_adopt: new Map(),
      grant_valid: new Map(),
      created_at: input.now
    });
    if (!handoff.ok) {
      return revErr(revErrorFromEnvelope(handoff.error));
    }
    const byId = new Map(proposals.map((proposal) => [proposal.proposal_id, proposal]));
    const validated = validateHandoff(handoff.value, byId);
    if (!validated.ok) {
      return revErr(revErrorFromEnvelope(validated.error));
    }
    const committed = await this.deps.handoffCommit({
      job,
      snapshot,
      handoff: handoff.value,
      proposals,
      now: input.now
    });
    if (!committed.ok) {
      return revErr(revErrorFromEnvelope(committed.error));
    }
    return revOk(committed.value);
  }

  async listAdoptable(input: {
    job_id: string;
  }): Promise<RevResult<Array<{ proposal: Proposal; handoff: ReviewHandoff; auto_adopt_eligible: boolean }>>> {
    const job = await this.deps.repo.getJob(input.job_id);
    if (job === null) {
      return revErr(revErrorFromCode("E_ILLEGAL_REVIEW_JOB_TRANSITION", "job_transition", false));
    }
    const handoff = await this.deps.repo.getHandoffByJob(job.job_id);
    if (handoff === null || job.state !== "done") {
      return revOk([]);
    }
    const proposals = await this.deps.repo.listProposals(job.job_id);
    const byId = new Map(proposals.map((proposal) => [proposal.proposal_id, proposal]));
    const result: Array<{ proposal: Proposal; handoff: ReviewHandoff; auto_adopt_eligible: boolean }> = [];
    for (const entry of handoff.proposals) {
      const proposal = byId.get(entry.proposal_id);
      if (proposal !== undefined && entry.auto_adopt_eligible) {
        result.push({ proposal, handoff, auto_adopt_eligible: entry.auto_adopt_eligible });
      }
    }
    return revOk(result);
  }

  private validityPorts(job: ReviewJob): SnapshotValidityPorts {
    return {
      goal: this.deps.goal,
      config: this.deps.config,
      policySupported: this.deps.policySupported,
      supersededByJobId: job.superseded_by_job_id ?? null
    };
  }

  private async maxAttemptsFor(job: ReviewJob): Promise<number> {
    const snapshot = await this.deps.repo.getSnapshot(job.snapshot_id);
    return snapshot?.budget.max_attempts ?? 1;
  }

  private async settleAttempt(
    attempt: ReviewAttempt,
    job: ReviewJob,
    outcome: "succeeded" | "failed" | "cancelled" | "unknown"
  ): Promise<Result<ReviewJob, ErrorEnvelope>> {
    if (attempt.budget.reservation_id === undefined) {
      return ok(job);
    }
    const settled = await this.deps.budget.settle({
      reservation_id: attempt.budget.reservation_id,
      outcome,
      provider_usage: null
    });
    if (!settled.ok) {
      return err(settled.error);
    }
    if (settled.value.state === "unsettled") {
      // FND settled the attempt with `usage_unknown`; the attempt charge is
      // still real. That is a degraded ledger state, not a divergence: REV
      // projects it as `unknown_usage` so no retry or second reserve can
      // silently spend the same allowance again.
    }
    const add = (left: number | null, right: number | null): number | null =>
      left === null || right === null ? null : left + right;
    return ok({
      ...job,
      allowance_charge: {
        ...job.allowance_charge,
        input_tokens_charged: add(job.allowance_charge.input_tokens_charged, settled.value.input_token_charges),
        output_tokens_charged: add(job.allowance_charge.output_tokens_charged, settled.value.output_token_charges),
        cost_micros_charged: add(job.allowance_charge.cost_micros_charged, settled.value.cost_charges_micros),
        unknown_usage: job.allowance_charge.unknown_usage || settled.value.state !== "settled",
        overage: job.allowance_charge.overage || settled.value.overage
      },
      version: job.version + 1,
      updated_at: job.updated_at
    });
  }
}

/**
 * Frozen content-addressed reference to a HOST backend selection. Each
 * selection produces a distinct ref, so a retry never reuses the previous
 * blocked/generating selection.
 */
export function backendSelectionRef(
  selection: import("./host-contracts.js").GenerationBackendSelection
): SourceRef {
  const bytes = canonicalJson(toJsonValue(selection));
  return `blob://${hashBytes(bytes)}#bytes=0-${String(bytes.byteLength)}` as SourceRef;
}

interface RequiredCapabilitiesMissing {
  reason: "capability_unknown" | "capability_unsupported" | "capability_failed";
  missing: import("./host-contracts.js").GenerationCapabilityBinding[];
}

/**
 * J1 admission: `create`, `auth` and `output` must be verified. A missing
 * `service_profile` is `capability_unknown` (DD-REV-040).
 */
function requiredCapabilitiesMissing(
  selection: Extract<
    import("./host-contracts.js").GenerationBackendSelection,
    { state: "available" }
  >
): RequiredCapabilitiesMissing | null {
  const profile = selection.service_profile as
    | import("./host-contracts.js").ServiceProfile
    | undefined;
  if (profile === undefined) {
    return {
      reason: "capability_unknown",
      missing: [
        selection.backend.capabilities.create,
        selection.backend.capabilities.auth,
        selection.backend.capabilities.output
      ].map((item) => ({ ...item }))
    };
  }
  const required = [
    selection.backend.capabilities.create,
    selection.backend.capabilities.auth,
    selection.backend.capabilities.output
  ];
  const missing = required.filter((item) => item.status !== "verified");
  if (missing.length === 0) {
    return null;
  }
  const has = (status: "unknown" | "unsupported" | "failed"): boolean =>
    missing.some((item) => item.status === status);
  const reason = has("unsupported")
    ? "capability_unsupported"
    : has("failed")
      ? "capability_failed"
      : "capability_unknown";
  return { reason, missing: missing.map((item) => ({ ...item })) };
}
