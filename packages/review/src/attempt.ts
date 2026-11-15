/**
 * ReviewAttempt lifecycle, leases, fencing and per-attempt quota
 * (DD-REV-030, -031, -032, -033).
 *
 * The FND budget ledger is authoritative. Everything in `allowance_charge`
 * here is a read-only projection.
 */

import { canonicalHash, toJsonValue } from "@evoplug/core";
import type { Hash, Id, Result, VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { ErrorEnvelope } from "@evoplug/core";

import { budgetExhausted, leaseExpired } from "./errors.js";
import type {
  BudgetClaimRequestLike,
  BudgetReserveRequestLike,
  BudgetSettlementLike
} from "./budget-contracts.js";
import type {
  ReviewJob,
  ReviewAttempt,
  ReviewAttemptBudget,
  ReviewAttemptLease,
  ReviewAttemptState,
  ReviewQuotaPolicy
} from "./types.js";

export const ATTEMPT_MAX_ORDINAL = 10 as const;

export const LEASE_DEFAULTS: LeaseTimings = Object.freeze({
  attempt_lease_ttl_ms: 30_000,
  heartbeat_interval_ms: 10_000,
  start_grace_ms: 10_000,
  exit_grace_ms: 2_000,
  cancel_ack_grace_ms: 5_000,
  terminate_wait_ms: 3_000
});

export const LEASE_RANGES: Readonly<Record<keyof LeaseTimings, { readonly min: number; readonly max: number }>> = Object.freeze({
  attempt_lease_ttl_ms: { min: 5_000, max: 300_000 },
  heartbeat_interval_ms: { min: 1_000, max: 60_000 },
  start_grace_ms: { min: 1_000, max: 60_000 },
  exit_grace_ms: { min: 500, max: 30_000 },
  cancel_ack_grace_ms: { min: 1_000, max: 30_000 },
  terminate_wait_ms: { min: 500, max: 10_000 }
});

export interface LeaseTimings {
  attempt_lease_ttl_ms: number;
  heartbeat_interval_ms: number;
  start_grace_ms: number;
  exit_grace_ms: number;
  cancel_ack_grace_ms: number;
  terminate_wait_ms: number;
}

export function validateLeaseTimings(timings: LeaseTimings): Result<LeaseTimings, ErrorEnvelope> {
  for (const key of Object.keys(LEASE_RANGES) as Array<keyof typeof LEASE_RANGES>) {
    const range = LEASE_RANGES[key];
    const value = timings[key];
    if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
      return err(
        budgetExhausted({
          scopeKey: "lease",
          policyVersion: "lease/1",
          budgetKind: "deadline",
          remaining: value
        })
      );
    }
  }
  if (timings.heartbeat_interval_ms * 2 >= timings.attempt_lease_ttl_ms) {
    return err(
      budgetExhausted({
        scopeKey: "lease",
        policyVersion: "lease/1",
        budgetKind: "deadline",
        remaining: timings.heartbeat_interval_ms
      })
    );
  }
  return ok(timings);
}

export function attemptKey(input: {
  job_id: Id<"job">;
  ordinal: number;
  snapshot_hash: Hash;
  policy_version: string;
}): Hash {
  return canonicalHash(
    toJsonValue({
      job_id: input.job_id,
      ordinal: input.ordinal,
      snapshot_hash: input.snapshot_hash,
      policy_version: input.policy_version
    })
  );
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

export const ATTEMPT_STATES: readonly ReviewAttemptState[] = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost"
];

const ATTEMPT_EDGES: Readonly<Record<ReviewAttemptState, readonly ReviewAttemptState[]>> = {
  queued: ["leased", "failed", "cancelled"],
  leased: ["running", "failed", "cancelled", "lost"],
  running: ["succeeded", "failed", "cancelled", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: []
};

export function isAttemptTransitionAllowed(from: ReviewAttemptState, to: ReviewAttemptState): boolean {
  return ATTEMPT_EDGES[from].includes(to);
}

export function isTerminalAttemptState(state: ReviewAttemptState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "lost";
}

export function attemptTransitionError(
  from: ReviewAttemptState,
  to: ReviewAttemptState
): ErrorEnvelope | null {
  if (isAttemptTransitionAllowed(from, to)) {
    return null;
  }
  return {
    schema_version: "rsi.error/1",
    code: "E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION",
    category: "usage",
    retryable: false,
    side_effect: "none",
    message_key: "error.e_review_illegal_attempt_transition",
    details: { kind: "field", path: "attempt.state", rule: `${from}->${to}` },
    stage: "attempt_transition",
    trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
  };
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

export interface ClaimQuotaInput {
  budget: ReviewQuotaPolicy;
  unknown_usage: boolean;
  input_tokens_charged: number;
  output_tokens_charged: number;
  now: number;
}

export interface ClaimQuota {
  input_tokens_estimated: number;
  output_tokens_reserved: number;
  wall_ms_reserved: number;
  deadline_ms: number;
}

export type ClaimQuotaResult =
  | { kind: "claimed"; quota: ClaimQuota }
  | { kind: "exhausted"; reason: "budget_exhausted" | "deadline_too_short" | "unknown_usage" };

/**
 * DD-REV-033 quota algorithm. `unknown_usage` refuses a new reserve before
 * any arithmetic.
 */
export function computeClaimQuota(input: ClaimQuotaInput): ClaimQuotaResult {
  if (input.unknown_usage) {
    return { kind: "exhausted", reason: "unknown_usage" };
  }
  const remainingInput = input.budget.max_input_tokens - input.input_tokens_charged;
  const remainingOutput = input.budget.max_output_tokens - input.output_tokens_charged;
  const wallMsReserved = input.budget.wall_ms;
  const outputTokensReserved = Math.min(remainingOutput, input.budget.request_max_tokens);
  const inputTokensEstimated = Math.min(
    remainingInput,
    input.budget.request_max_tokens - outputTokensReserved
  );
  if (inputTokensEstimated < 1 || outputTokensReserved < 1) {
    return { kind: "exhausted", reason: "budget_exhausted" };
  }
  if (wallMsReserved < input.budget.min_work_ms) {
    return { kind: "exhausted", reason: "deadline_too_short" };
  }
  return {
    kind: "claimed",
    quota: {
      input_tokens_estimated: inputTokensEstimated,
      output_tokens_reserved: outputTokensReserved,
      wall_ms_reserved: wallMsReserved,
      deadline_ms: input.now + wallMsReserved
    }
  };
}

export function claimQuotaError(
  budget: ReviewQuotaPolicy,
  reason: "budget_exhausted" | "deadline_too_short" | "unknown_usage"
): ErrorEnvelope {
  return budgetExhausted({
    scopeKey: budget.budget_policy_ref,
    policyVersion: budget.budget_policy_version,
    budgetKind: reason === "deadline_too_short" ? "deadline" : "token",
    remaining: 0
  });
}

/** `binding` for reserve uses the snapshot's stable watermark. */
export function reserveBinding(job: ReviewJob, stableWatermark: number): VersionBinding {
  return {
    task_id: job.task_id,
    branch_id: job.branch_id,
    input_epoch: job.input_epoch,
    goal_version: job.goal_version,
    config_version: job.config_version,
    watermark: stableWatermark
  };
}

export function buildBudgetReserveRequest(input: {
  job: ReviewJob;
  attemptKey: Hash;
  stableWatermark: number;
  quota: ClaimQuota;
  serviceProfile: NonNullable<ReviewJob["backend"]["service_profile"]>;
}): BudgetReserveRequestLike {
  return {
    reservation_key: input.attemptKey,
    binding: reserveBinding(input.job, input.stableWatermark),
    purpose: "review_generate",
    scope_key: input.job.review_scope_key,
    service_profile_id: input.serviceProfile.service_profile_id,
    provider_scope: input.serviceProfile.provider_scope,
    limits: input.serviceProfile.limits,
    input_tokens_requested: input.quota.input_tokens_estimated,
    output_tokens_requested: input.quota.output_tokens_reserved,
    deadline_ms: input.quota.deadline_ms
  };
}

export function buildBudgetClaimRequest(input: {
  reservationId: Id<"resv">;
  attemptKey: Hash;
  quota: ClaimQuota;
}): BudgetClaimRequestLike {
  return {
    reservation_id: input.reservationId,
    attempt_ref: input.attemptKey,
    input_tokens_estimated: input.quota.input_tokens_estimated,
    output_tokens_reserved: input.quota.output_tokens_reserved,
    counting_method_version: "rsi.review_count/1",
    deadline_ms: input.quota.deadline_ms
  };
}

export function unclaimedBudget(quota: ClaimQuota): ReviewAttemptBudget {
  return {
    state: "unclaimed",
    input_tokens_estimated: quota.input_tokens_estimated,
    output_tokens_reserved: quota.output_tokens_reserved,
    wall_ms_reserved: quota.wall_ms_reserved
  };
}

/* ------------------------------------------------------------------ */
/* Leases                                                              */
/* ------------------------------------------------------------------ */

export function createLease(input: {
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  now: number;
  timings: LeaseTimings;
  processRef?: { pid: number; start_token: string; pgid?: number };
}): ReviewAttemptLease {
  const lease: ReviewAttemptLease = {
    lease_id: input.leaseId,
    owner_id: input.ownerId,
    fencing_token: input.fencingToken,
    acquired_at: input.now,
    heartbeat_at: input.now,
    expires_at: input.now + input.timings.attempt_lease_ttl_ms
  };
  if (input.processRef !== undefined) {
    lease.process_ref = input.processRef;
  }
  return lease;
}

export interface HeartbeatPredicateInput {
  attempt: ReviewAttempt;
  job: ReviewJob;
  now: number;
  lease_id: string;
  fencing_token: number;
}

/** Joint heartbeat predicate (DD-REV-032); any miss stops the worker. */
export function heartbeatAllowed(input: HeartbeatPredicateInput): Result<true, ErrorEnvelope> {
  const { attempt, job, now } = input;
  const lease = attempt.lease;
  if (lease === undefined) {
    return err(leaseExpired("lease", "missing"));
  }
  if (attempt.state !== "leased" && attempt.state !== "running") {
    return err(leaseExpired("attempt.state", attempt.state));
  }
  if (attempt.job_id !== job.job_id) {
    return err(leaseExpired("attempt.job_id", attempt.job_id));
  }
  if (job.state !== "generating") {
    return err(leaseExpired("job.state", job.state));
  }
  if (job.active_attempt_id !== attempt.attempt_id) {
    return err(leaseExpired("job.active_attempt_id", job.active_attempt_id ?? "null"));
  }
  if (job.current_fencing_token !== lease.fencing_token) {
    return err(leaseExpired("job.current_fencing_token", String(job.current_fencing_token)));
  }
  if (lease.lease_id !== input.lease_id) {
    return err(leaseExpired("lease.lease_id", input.lease_id));
  }
  if (lease.fencing_token !== input.fencing_token) {
    return err(leaseExpired("lease.fencing_token", String(input.fencing_token)));
  }
  if (lease.expires_at <= now) {
    return err(leaseExpired("lease.expires_at", String(lease.expires_at)));
  }
  if (attempt.cancel.requested_at !== undefined) {
    return err(leaseExpired("attempt.cancel.requested_at", String(attempt.cancel.requested_at)));
  }
  return ok(true);
}

export function refreshLease(input: {
  lease: ReviewAttemptLease;
  now: number;
  timings: LeaseTimings;
}): ReviewAttemptLease {
  return {
    ...input.lease,
    heartbeat_at: input.now,
    expires_at: input.now + input.timings.attempt_lease_ttl_ms
  };
}

export function isLeaseExpired(lease: ReviewAttemptLease | undefined, now: number): boolean {
  return lease === undefined || lease.expires_at <= now;
}

export function requestCancel(
  attempt: ReviewAttempt,
  now: number,
  mode: "cooperative" | "terminate"
): ReviewAttempt {
  return {
    ...attempt,
    cancel: {
      ...attempt.cancel,
      requested_at: attempt.cancel.requested_at ?? now,
      mode
    },
    row_version: attempt.row_version + 1,
    updated_at: now
  };
}

/* ------------------------------------------------------------------ */
/* Accept-output fencing                                               */
/* ------------------------------------------------------------------ */

export interface FencingInput {
  attempt: ReviewAttempt;
  job: ReviewJob;
  lease_id: string;
  fencing_token: number;
  now: number;
}

/** `acceptOutput` rechecks every joint predicate in one transaction. */
export function acceptFencingError(input: FencingInput): ErrorEnvelope | null {
  const { attempt, job } = input;
  if (job.state !== "generating") {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: { kind: "version", expected: "generating", actual: job.state },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  if (job.active_attempt_id !== attempt.attempt_id) {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: { kind: "version", expected: attempt.attempt_id, actual: job.active_attempt_id ?? "null" },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  if (attempt.cancel.requested_at !== undefined) {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: { kind: "version", expected: "no_cancel", actual: "cancel_requested" },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  const lease = attempt.lease;
  if (lease === undefined || lease.lease_id !== input.lease_id) {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: { kind: "version", expected: input.lease_id, actual: lease?.lease_id ?? "null" },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  if (lease.fencing_token !== input.fencing_token || job.current_fencing_token !== input.fencing_token) {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: {
        kind: "version",
        expected: String(input.fencing_token),
        actual: String(job.current_fencing_token)
      },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  if (lease.expires_at <= input.now) {
    return {
      schema_version: "rsi.error/1",
      code: "E_REVIEW_FENCING_STALE",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.e_review_fencing_stale",
      details: { kind: "version", expected: "active", actual: "expired" },
      stage: "accept_output",
      trace_id: "ipc:00000000000000000000000000" as Id<"ipc">
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

export function settlementOutcome(state: ReviewAttemptState): "succeeded" | "failed" | "cancelled" | "unknown" {
  switch (state) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
    case "queued":
    case "leased":
    case "running":
      return "unknown";
  }
}

export function applySettlementToAttempt(input: {
  attempt: ReviewAttempt;
  settlement: BudgetSettlementLike;
  chargeIds: Id<"chg">[];
  now: number;
}): ReviewAttempt {
  const { settlement } = input;
  return {
    ...input.attempt,
    budget: {
      ...input.attempt.budget,
      state: settlement.state === "settled" ? "settled" : "unsettled",
      settlement
    },
    allowance_charge: {
      charge_ids: [...input.attempt.allowance_charge.charge_ids, ...input.chargeIds],
      input_token_charges: settlement.input_token_charges,
      output_token_charges: settlement.output_token_charges,
      cost_charges_micros: settlement.cost_charges_micros,
      overage: settlement.overage
    },
    row_version: input.attempt.row_version + 1,
    updated_at: input.now
  };
}

function addNullable(total: number | null, value: number | null): number | null {
  if (total === null || value === null) {
    return null;
  }
  return total + value;
}

export function applySettlementToJob(
  job: ReviewJob,
  settlement: BudgetSettlementLike,
  now: number
): ReviewJob {
  const unknown = job.allowance_charge.unknown_usage || settlement.state !== "settled";
  return {
    ...job,
    allowance_charge: {
      ...job.allowance_charge,
      input_tokens_charged: addNullable(job.allowance_charge.input_tokens_charged, settlement.input_token_charges),
      output_tokens_charged: addNullable(job.allowance_charge.output_tokens_charged, settlement.output_token_charges),
      cost_micros_charged: addNullable(job.allowance_charge.cost_micros_charged, settlement.cost_charges_micros),
      unknown_usage: unknown,
      overage: job.allowance_charge.overage || settlement.overage
    },
    version: job.version + 1,
    updated_at: now
  };
}

export function recordReservation(
  job: ReviewJob,
  reservationId: Id<"resv">,
  chargeId: Id<"chg">,
  now: number
): ReviewJob {
  return {
    ...job,
    allowance_charge: {
      ...job.allowance_charge,
      reservation_ids: [...job.allowance_charge.reservation_ids, reservationId],
      charge_ids: [...job.allowance_charge.charge_ids, chargeId],
      attempts: job.allowance_charge.attempts + 1
    },
    version: job.version + 1,
    updated_at: now
  };
}

/* ------------------------------------------------------------------ */
/* Attempt construction                                                */
/* ------------------------------------------------------------------ */

export interface NewAttemptInput {
  attempt_id: Id<"rat">;
  job: ReviewJob;
  snapshot_hash: Hash;
  quota: ClaimQuota;
  backend: ReviewAttempt["backend"];
  model_id: string;
  host_run: ReviewAttempt["host_run"];
  isolation: ReviewAttempt["isolation"];
  input_manifest_ref: import("@evoplug/core").SourceRef;
  input_manifest_hash: Hash;
  output_ref: import("@evoplug/core").SourceRef;
  created_at: number;
}

export function buildQueuedAttempt(input: NewAttemptInput): ReviewAttempt {
  const ordinal = input.job.attempt_count + 1;
  return {
    schema_version: "rsi.review_attempt/1",
    attempt_id: input.attempt_id,
    attempt_key: attemptKey({
      job_id: input.job.job_id,
      ordinal,
      snapshot_hash: input.snapshot_hash,
      policy_version: input.job.policy_version
    }),
    job_id: input.job.job_id,
    ordinal,
    state: "queued",
    backend: input.backend,
    model_id: input.model_id,
    protocol_version: "rsi.generator_protocol/1",
    host_run: input.host_run,
    isolation: input.isolation,
    input_manifest_ref: input.input_manifest_ref,
    input_manifest_hash: input.input_manifest_hash,
    output_ref: input.output_ref,
    budget: unclaimedBudget(input.quota),
    cancel: {},
    allowance_charge: {
      charge_ids: [],
      input_token_charges: null,
      output_token_charges: null,
      cost_charges_micros: null,
      overage: false
    },
    provider_usage: {
      usage_refs: [],
      input_tokens: null,
      output_tokens: null,
      cost_micros: null,
      cost_status: "not_applicable",
      source: "none"
    },
    row_version: 1,
    created_at: input.created_at,
    updated_at: input.created_at
  };
}

export function applyLease(input: {
  attempt: ReviewAttempt;
  job: ReviewJob;
  lease: ReviewAttemptLease;
  reservationId: Id<"resv">;
  attemptChargeId: Id<"chg">;
  effectiveDeadlineMs: number;
  now: number;
}): { attempt: ReviewAttempt; job: ReviewJob } {
  const attempt: ReviewAttempt = {
    ...input.attempt,
    state: "leased",
    lease: input.lease,
    deadline_at: input.effectiveDeadlineMs,
    budget: {
      ...input.attempt.budget,
      reservation_id: input.reservationId,
      attempt_charge_id: input.attemptChargeId,
      state: "claimed"
    },
    row_version: input.attempt.row_version + 1,
    updated_at: input.now
  };
  const job: ReviewJob = {
    ...input.job,
    state: "generating",
    stage: "generate",
    active_attempt_id: input.attempt.attempt_id,
    current_fencing_token: input.attempt.lease?.fencing_token ?? input.job.current_fencing_token + 1,
    attempt_count: input.job.attempt_count + 1,
    version: input.job.version + 1,
    updated_at: input.now
  };
  delete job.block_reason;
  return { attempt, job };
}

export function markAttemptRunning(attempt: ReviewAttempt, now: number, processRef?: ReviewAttemptLease["process_ref"]): ReviewAttempt {
  const next: ReviewAttempt = {
    ...attempt,
    state: "running",
    started_at: now,
    row_version: attempt.row_version + 1,
    updated_at: now
  };
  if (processRef !== undefined && next.lease !== undefined) {
    next.lease = { ...next.lease, process_ref: processRef };
  }
  return next;
}

export function markAttemptTerminal(input: {
  attempt: ReviewAttempt;
  state: Extract<ReviewAttemptState, "succeeded" | "failed" | "cancelled" | "lost">;
  now: number;
  error?: { code: string; line?: number; detail_ref?: import("@evoplug/core").SourceRef };
  exit?: ReviewAttempt["exit"];
  completionEvidenceRef?: import("@evoplug/core").SourceRef;
  output?: ReviewAttempt["output"];
}): ReviewAttempt {
  const next: ReviewAttempt = {
    ...input.attempt,
    state: input.state,
    ended_at: input.now,
    row_version: input.attempt.row_version + 1,
    updated_at: input.now
  };
  if (input.error !== undefined) {
    next.last_error = input.error;
  }
  if (input.exit !== undefined) {
    next.exit = input.exit;
  }
  if (input.completionEvidenceRef !== undefined) {
    next.completion_evidence_ref = input.completionEvidenceRef;
  }
  if (input.output !== undefined) {
    next.output = input.output;
  }
  return next;
}

/** Recovery matrix action (DD-REV-032). */
export type RecoveryPoint =
  | "before_spawn"
  | "after_lease_before_running"
  | "running_exit_without_terminal"
  | "after_completed_before_commit"
  | "after_check_before_handoff"
  | "lease_expired_process_alive"
  | "cancel_no_response";

export interface RecoveryAction {
  point: RecoveryPoint;
  attempt_state: "failed" | "lost" | "cancelled" | "succeeded" | "unchanged";
  job_transition: "J6" | "J7" | "none";
  terminal_reason: string | null;
  discard_output: boolean;
}

export function recoveryAction(point: RecoveryPoint): RecoveryAction {
  switch (point) {
    case "before_spawn":
      return {
        point,
        attempt_state: "failed",
        job_transition: "J6",
        terminal_reason: "E_REVIEW_BACKEND_SPAWN",
        discard_output: true
      };
    case "after_lease_before_running":
      return {
        point,
        attempt_state: "lost",
        job_transition: "J7",
        terminal_reason: "E_REVIEW_ORPHAN_UNKNOWN",
        discard_output: true
      };
    case "running_exit_without_terminal":
      return {
        point,
        attempt_state: "lost",
        job_transition: "J6",
        terminal_reason: null,
        discard_output: true
      };
    case "after_completed_before_commit":
      return {
        point,
        attempt_state: "succeeded",
        job_transition: "none",
        terminal_reason: null,
        discard_output: false
      };
    case "after_check_before_handoff":
      return {
        point,
        attempt_state: "unchanged",
        job_transition: "none",
        terminal_reason: null,
        discard_output: false
      };
    case "lease_expired_process_alive":
      return {
        point,
        attempt_state: "lost",
        job_transition: "J6",
        terminal_reason: "E_REVIEW_LEASE_EXPIRED",
        discard_output: true
      };
    case "cancel_no_response":
      return {
        point,
        attempt_state: "cancelled",
        job_transition: "none",
        terminal_reason: null,
        discard_output: true
      };
  }
}

export function completionEvidenceKind(
  backendKind: ReviewAttempt["backend"]["backend_kind"]
): "exit_code" | "host_session_end" | "terminal_evidence" {
  switch (backendKind) {
    case "cli":
      return "exit_code";
    case "host_native_subagent":
      return "host_session_end";
    case "sdk":
    case "service":
      return "terminal_evidence";
  }
}

export function buildCancelKey(attemptId: string): string {
  return `cancel:${attemptId}`;
}
