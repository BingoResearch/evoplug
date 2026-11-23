/**
 * ReviewJob state machine, dedupe, supersession and terminal semantics
 * (DD-REV-020, -021, -022, -033).
 *
 * Legal edges are the J1..J16 table. Supersede (J14) wins over J8/J11 when
 * both apply; the caller must use `selectStaleTransition` to pick it.
 */


import type { Id, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import {
  illegalJobTransition,
  supersedeInvalid
} from "./errors.js";
import type { ReviewEnqueueRequest } from "./host-contracts.js";
import type { ReviewJob, ReviewJobAllowanceCharge, ReviewJobProviderUsage, ReviewJobResult, ReviewJobState, ReviewSnapshot } from "./types.js";

export const REVIEW_JOB_STATES: readonly ReviewJobState[] = [
  "queued",
  "blocked_no_backend",
  "generating",
  "proposed",
  "stale",
  "done",
  "failed",
  "cancelled"
];

export const REVIEW_TERMINAL_JOB_STATES: readonly ReviewJobState[] = [
  "stale",
  "done",
  "failed",
  "cancelled"
];

interface JobTransitionRow {
  readonly id: "J1" | "J2" | "J3" | "J4" | "J5" | "J6" | "J7" | "J8" | "J9" | "J10" | "J11" | "J12" | "J14" | "J15" | "J16";
  readonly from: readonly ReviewJobState[];
  readonly to: ReviewJobState;
  readonly error: string;
}

export const JOB_TRANSITIONS: readonly JobTransitionRow[] = [
  { id: "J1", from: ["queued"], to: "generating", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J2", from: ["queued"], to: "blocked_no_backend", error: "E_REVIEW_BACKEND_UNAVAILABLE" },
  { id: "J3", from: ["blocked_no_backend"], to: "generating", error: "E_REVIEW_SNAPSHOT_STALE" },
  { id: "J4", from: ["blocked_no_backend"], to: "stale", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J5", from: ["generating"], to: "proposed", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J6", from: ["generating"], to: "queued", error: "E_REVIEW_BUDGET_EXHAUSTED" },
  { id: "J7", from: ["generating"], to: "failed", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J8", from: ["generating"], to: "stale", error: "E_REVIEW_SNAPSHOT_STALE" },
  { id: "J9", from: ["generating"], to: "cancelled", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J10", from: ["proposed"], to: "done", error: "E_HANDOFF_INCOMPLETE" },
  { id: "J11", from: ["proposed"], to: "stale", error: "E_REVIEW_SNAPSHOT_STALE" },
  { id: "J12", from: ["proposed"], to: "cancelled", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" },
  { id: "J14", from: ["queued", "blocked_no_backend", "generating", "proposed"], to: "stale", error: "E_REVIEW_SUPERSEDE_INVALID" },
  { id: "J15", from: ["queued"], to: "stale", error: "E_REVIEW_SNAPSHOT_STALE" },
  { id: "J16", from: ["queued"], to: "failed", error: "E_ILLEGAL_REVIEW_JOB_TRANSITION" }
];

/** Forbidden `from -> to` pairs from the invalid-transition table. */
const FORBIDDEN_TRANSITIONS: Readonly<Record<ReviewJobState, readonly ReviewJobState[]>> = {
  stale: [...REVIEW_JOB_STATES],
  done: [...REVIEW_JOB_STATES],
  cancelled: [...REVIEW_JOB_STATES],
  failed: [...REVIEW_JOB_STATES],
  queued: ["proposed", "done"],
  blocked_no_backend: ["proposed", "done"],
  generating: ["blocked_no_backend", "done"],
  proposed: ["generating", "queued", "blocked_no_backend"]
};

export function isTerminalJobState(state: ReviewJobState): boolean {
  return REVIEW_TERMINAL_JOB_STATES.includes(state);
}

export function isJobTransitionAllowed(from: ReviewJobState, to: ReviewJobState): boolean {
  if (isTerminalJobState(from)) {
    return false;
  }
  if (FORBIDDEN_TRANSITIONS[from].includes(to)) {
    return false;
  }
  return JOB_TRANSITIONS.some((row) => row.to === to && row.from.includes(from));
}

export function jobTransitionError(from: ReviewJobState, to: ReviewJobState): ErrorEnvelope | null {
  if (isJobTransitionAllowed(from, to)) {
    return null;
  }
  return illegalJobTransition(from, to);
}

/* ------------------------------------------------------------------ */
/* Supersession                                                        */
/* ------------------------------------------------------------------ */

function nextSupersessionDepth(previousDepth: number): number {
  return previousDepth + 1;
}

export function supersedeDepthExceeded(depth: number): boolean {
  return depth > 3;
}

interface SupersedeValidationInput {
  oldJob: ReviewJob;
  newJob: Pick<ReviewJob, "snapshot_hash" | "task_id" | "branch_id" | "created_at">;
  newJobId: Id<"job">;
}

/** J14 preconditions: same task/branch, earlier job, different snapshot. */
export function validateSupersede(input: SupersedeValidationInput): Result<number, ErrorEnvelope> {
  if (input.oldJob.task_id !== input.newJob.task_id) {
    return err(supersedeInvalid("supersedes_job_id", "same_task"));
  }
  if (input.oldJob.branch_id !== input.newJob.branch_id) {
    return err(supersedeInvalid("supersedes_job_id", "same_branch"));
  }
  if (input.oldJob.job_id === input.newJobId) {
    return err(supersedeInvalid("supersedes_job_id", "different_job"));
  }
  if (input.oldJob.created_at > input.newJob.created_at) {
    return err(supersedeInvalid("supersedes_job_id", "older_job"));
  }
  if (input.oldJob.snapshot_hash === input.newJob.snapshot_hash) {
    return err(supersedeInvalid("supersedes_job_id", "different_snapshot"));
  }
  if (isTerminalJobState(input.oldJob.state)) {
    return err(supersedeInvalid("supersedes_job_id", "non_terminal"));
  }
  return ok(nextSupersessionDepth(input.oldJob.supersession_depth));
}

/**
 * Applies J14 to the old job. `cancel_active_attempt` tells the caller to
 * persist `cancel.requested_at` on the active attempt.
 */
interface SupersedeResult {
  job: ReviewJob;
  cancel_active_attempt: boolean;
}

export function applySupersede(
  oldJob: ReviewJob,
  newJobId: Id<"job">,
  now: number
): SupersedeResult {
  const job: ReviewJob = {
    ...oldJob,
    state: "stale",
    stage: "closed",
    superseded_by_job_id: newJobId,
    terminal_reason: "superseded",
    terminal_at: now,
    current_fencing_token: oldJob.current_fencing_token + 1,
    version: oldJob.version + 1,
    updated_at: now
  };
  return {
    job,
    cancel_active_attempt: oldJob.active_attempt_id !== undefined
  };
}

/* ------------------------------------------------------------------ */
/* Stale / cancel selection                                            */
/* ------------------------------------------------------------------ */

type StaleSelection =
  | { kind: "superseded" }
  | { kind: "stale"; reason: Exclude<string, "superseded"> };

/** J14 wins when a job is both superseded and target-stale. */
export function selectStaleTransition(input: {
  supersededByJobId: Id<"job"> | null;
  staleReason: string | null;
}): StaleSelection {
  if (input.supersededByJobId !== null) {
    return { kind: "superseded" };
  }
  return { kind: "stale", reason: input.staleReason ?? "target_changed" };
}

interface StaleJobOptions {
  reason: string;
  now: number;
  cancelActiveAttempt: boolean;
  jobResultTransitionId: "J4" | "J8" | "J11" | "J14" | "J15";
}

export function markJobStale(job: ReviewJob, options: StaleJobOptions): ReviewJob {
  void options.jobResultTransitionId;
  const next: ReviewJob = {
    ...job,
    state: "stale",
    stage: "closed",
    terminal_reason: options.reason,
    terminal_at: options.now,
    current_fencing_token: job.current_fencing_token + (options.cancelActiveAttempt ? 1 : 0),
    version: job.version + 1,
    updated_at: options.now
  };
  return next;
}

export function markJobFailed(
  job: ReviewJob,
  reason: string,
  now: number,
  lastError?: NonNullable<ReviewJob["last_error"]>
): ReviewJob {
  return {
    ...job,
    state: "failed",
    stage: "closed",
    ...(lastError === undefined ? {} : { last_error: lastError }),
    terminal_reason: reason,
    terminal_at: now,
    version: job.version + 1,
    updated_at: now
  };
}

export function markJobCancelled(job: ReviewJob, now: number): ReviewJob {
  return {
    ...job,
    state: "cancelled",
    stage: "closed",
    terminal_at: now,
    current_fencing_token: job.current_fencing_token + 1,
    version: job.version + 1,
    updated_at: now
  };
}

export function markJobDone(job: ReviewJob, handoffId: Id<"hand">, handoffBodyRef: import("@evoplug/core").SourceRef, now: number): ReviewJob {
  return {
    ...job,
    state: "done",
    stage: "closed",
    handoff_id: handoffId,
    handoff_body_ref: handoffBodyRef,
    terminal_at: now,
    version: job.version + 1,
    updated_at: now
  };
}

/* ------------------------------------------------------------------ */
/* Job result aggregation                                              */
/* ------------------------------------------------------------------ */

interface JobResultInput {
  handoffProposalCount: number;
  candidateCount: number;
  rejectedCandidateCount: number;
  staleCandidateCount: number;
  staleProposalCount: number;
  acceptedProposalCount: number;
}

/**
 * `proposed` -> handoff has at least one proposal; otherwise
 * `no_candidate` -> zero candidate rows; otherwise any rejected -> `all_rejected`;
 * otherwise `all_stale`. Mixed rejected/stale prefers `all_rejected`.
 */
export function aggregateJobResult(input: JobResultInput): ReviewJobResult {
  if (input.handoffProposalCount > 0) {
    return "proposed";
  }
  if (input.candidateCount === 0) {
    return "no_candidate";
  }
  if (input.rejectedCandidateCount > 0) {
    return "all_rejected";
  }
  if (input.staleCandidateCount > 0 || input.staleProposalCount > 0) {
    return "all_stale";
  }
  return "all_stale";
}

/* ------------------------------------------------------------------ */
/* Budget claim mapping (DD-REV-033)                                   */
/* ------------------------------------------------------------------ */

type BudgetClaimReasonCode =
  | "attempt_exhausted"
  | "token_exhausted"
  | "cost_exhausted"
  | "deadline_too_short"
  | "limits_unknown"
  | "budget_unsettled"
  | "rate_limited"
  | "concurrency_limited";

interface ClaimBlockedDecision {
  job_transition: "J2" | "J16" | "stay_queued";
  block_reason: ReviewJob["block_reason"] | null;
  terminal_reason: string | null;
  retry_after_ms: number | null;
  write_last_error: boolean;
}

export function claimBlockedDecision(
  reasonCode: BudgetClaimReasonCode,
  retryAfterMs: number | null = null
): ClaimBlockedDecision {
  switch (reasonCode) {
    case "attempt_exhausted":
    case "token_exhausted":
    case "cost_exhausted":
      return {
        job_transition: "J16",
        block_reason: null,
        terminal_reason: "E_REVIEW_BUDGET_EXHAUSTED",
        retry_after_ms: null,
        write_last_error: true
      };
    case "deadline_too_short":
      return {
        job_transition: "J16",
        block_reason: null,
        terminal_reason: "E_DEADLINE_EXCEEDED",
        retry_after_ms: null,
        write_last_error: true
      };
    case "limits_unknown":
      return {
        job_transition: "J16",
        block_reason: null,
        terminal_reason: "limits_unknown",
        retry_after_ms: null,
        write_last_error: false
      };
    case "budget_unsettled":
      return {
        job_transition: "J2",
        block_reason: "budget_unavailable",
        terminal_reason: null,
        retry_after_ms: null,
        write_last_error: true
      };
    case "rate_limited":
    case "concurrency_limited":
      return {
        job_transition: "stay_queued",
        block_reason: null,
        terminal_reason: null,
        retry_after_ms: retryAfterMs,
        write_last_error: true
      };
  }
}

/* ------------------------------------------------------------------ */
/* Job construction                                                    */
/* ------------------------------------------------------------------ */

function emptyAllowanceCharge(): ReviewJobAllowanceCharge {
  return {
    reservation_ids: [],
    charge_ids: [],
    attempts: 0,
    input_tokens_charged: null,
    output_tokens_charged: null,
    cost_micros_charged: null,
    unknown_usage: false,
    overage: false
  };
}

function emptyProviderUsage(): ReviewJobProviderUsage {
  return {
    usage_refs: [],
    reported_attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_micros: null,
    cost_status: "not_applicable",
    sources: []
  };
}

interface NewJobInput {
  job_id: Id<"job">;
  snapshot: ReviewSnapshot;
  request: ReviewEnqueueRequest;
  now: number;
  supersedesJobId: Id<"job"> | null;
  supersessionDepth: number;
}

/** Builds the initial `queued/generate` job frozen from the snapshot. */
export function buildReviewJob(input: NewJobInput): ReviewJob {
  const { snapshot, request } = input;
  const job: ReviewJob = {
    schema_version: "rsi.review_job/2",
    job_id: input.job_id,
    request_id: request.request_id,
    task_id: snapshot.version_binding.task_id,
    branch_id: snapshot.version_binding.branch_id,
    snapshot_id: snapshot.snapshot_id,
    snapshot_hash: snapshot.snapshot_hash,
    trigger_event_id: snapshot.trigger.trigger_event_id,
    trigger_kind: snapshot.trigger.trigger_kind,
    review_kind: snapshot.trigger.review_kind,
    review_scope_key: snapshot.trigger.review_scope_key,
    boundary_key: snapshot.trigger.boundary_key,
    trigger_dedupe_key: snapshot.trigger.trigger_dedupe_key,
    signal_digest: snapshot.trigger.signal_digest,
    stable_event_ids: [...snapshot.trigger.stable_event_ids],
    stable_watermark: snapshot.boundary.stable_watermark,
    stable: snapshot.boundary.stable,
    stable_evidence_ref: snapshot.boundary.stable_evidence_ref,
    pending_state: snapshot.boundary.pending_state,
    pending_work_refs: [...snapshot.boundary.pending_work_refs],
    scope: { ...request.scope },
    origin: { ...request.origin },
    policy_ref: { ...snapshot.trigger.policy_ref },
    policy_version: snapshot.policy_version,
    policy_hash: snapshot.trigger.policy_hash,
    capability_snapshot_hash: snapshot.trigger.capability_snapshot_hash,
    budget_policy_ref: snapshot.budget.budget_policy_ref,
    budget_policy_hash: snapshot.budget.budget_policy_hash,
    input_epoch: snapshot.version_binding.input_epoch,
    goal_version: snapshot.version_binding.goal_version,
    config_version: snapshot.version_binding.config_version,
    state: "queued",
    stage: "generate",
    backend: {
      missing_capabilities: [],
      cancellation: "blocked",
      recovery: "blocked"
    },
    current_fencing_token: 0,
    attempt_count: 0,
    proposal_ids: [],
    supersession_depth: input.supersessionDepth,
    allowance_charge: emptyAllowanceCharge(),
    provider_usage: emptyProviderUsage(),
    version: 1,
    created_at: input.now,
    updated_at: input.now
  };
  if (snapshot.authorization_ref !== undefined) {
    job.authorization_ref = snapshot.authorization_ref;
  }
  if (input.supersedesJobId !== null) {
    job.supersedes_job_id = input.supersedesJobId;
  }
  return job;
}

/** Retry is allowed only from `generating` after a settled, non-unknown attempt. */
export function canRetryWithinJob(job: ReviewJob, maxAttempts: number): boolean {
  return (
    job.state === "generating" &&
    job.attempt_count < maxAttempts &&
    job.allowance_charge.unknown_usage === false &&
    job.allowance_charge.overage === false
  );
}

export function supersedeDepthTerminal(): string {
  return "E_REVIEW_SUPERSEDE_DEPTH";
}
