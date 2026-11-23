/**
 * Budget reservations, claims and settlements (DD-FND-081).
 *
 * Two ledgers never merge:
 * - `AllowanceCharge` is the local quota ledger; an attempt is charged at
 *   claim and is never refunded (`bpol/1` sets `attempt_refundable=false`).
 * - `ProviderUsage` is the provider receipt ledger; a missing receipt is
 *   `NULL`/`unknown`, never `0`.
 *
 * `RunBudget` is an in-process view clipped by the monotonic clock. It is not
 * persisted and never rewrites an old `rsi.budget/1` row.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SourceRef,
  Tx,
  VersionBinding,
} from "@evoplug/core";
import { err, isId, ok } from "@evoplug/core";

import {
  reserveInconsistent,
  schemaError,
  serviceProfileUnknown,
} from "./errors.js";
import type { BudgetPurpose, BudgetScopePolicy } from "./policy.js";
import { isBudgetPurpose } from "./policy.js";
import { budgetPolicyUnavailable } from "./errors.js";

export type BudgetReservationState =
  | "reserved"
  | "claimed"
  | "settled"
  | "released"
  | "expired"
  | "unsettled";

export type CostStatus = "known" | "unknown" | "not_applicable";

export interface RunBudget {
  schema_version: "rsi.budget/1";
  budget_id: Id<"bud">;
  run_id: Id<"run">;
  rsi_deadline_ms: number;
  handler_remaining_ms?: number;
  host_total_remaining_ms?: number;
  reserve_ms: number;
  min_work_ms: number;
  effective_ms: number;
  state: "active" | "degraded_noop" | "expired" | "cancelled";
}

export type ServiceProfileLimits =
  | {
      source: "verified_profile";
      profile_hash: Hash;
      request_max_tokens: number;
      question_max_tokens: number;
      max_output_tokens: number;
      rpm: number | null;
      concurrency: number | null;
      pricing:
        | {
            status: "known";
            input_micros_per_million: number;
            output_micros_per_million: number;
            fixed_micros: number;
          }
        | { status: "unknown" };
    }
  | {
      source: "unknown";
      profile_hash: null;
      reason_code: "profile_missing" | "limits_unknown" | "pricing_unknown";
    };

export interface BudgetReserveRequest {
  schema_version: "rsi.budget_reserve/1";
  reservation_key: string;
  binding: VersionBinding;
  purpose: BudgetPurpose;
  scope_key: string;
  service_profile_id: string;
  /** Stable `provider+endpoint+model` key. */
  provider_scope: string;
  limits: ServiceProfileLimits;
  input_tokens_requested: number;
  output_tokens_requested: number;
  deadline_ms: number;
}

export interface BudgetReservation {
  reservation_id: Id<"resv">;
  reservation_key: string;
  binding: VersionBinding;
  policy_version: "bpol/1";
  purpose: BudgetPurpose;
  state: BudgetReservationState;
  attempts_remaining: number;
  input_tokens_remaining: number;
  output_tokens_remaining: number;
  cost_micros_remaining: number | null;
  cost_status: CostStatus;
  expires_at: number;
  created_at: number;
}

export interface BudgetClaimRequest {
  reservation_id: Id<"resv">;
  attempt_ref: string;
  input_tokens_estimated: number;
  output_tokens_reserved: number;
  counting_method_version: string;
  deadline_ms: number;
}

type BudgetClaimBlockedReason =
  | "attempt_exhausted"
  | "token_exhausted"
  | "cost_exhausted"
  | "rate_limited"
  | "concurrency_limited"
  | "deadline_too_short"
  | "budget_unsettled"
  | "limits_unknown";

export type BudgetClaimResult =
  | {
      state: "claimed";
      reservation: BudgetReservation;
      attempt_charge_id: Id<"chg">;
      effective_deadline_ms: number;
    }
  | {
      state: "blocked";
      reason_code: BudgetClaimBlockedReason;
      retry_after_ms: number | null;
    };

export interface ProviderUsage {
  usage_key: string;
  attempt_ref: string;
  provider_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: CostStatus;
  source: "provider_receipt" | "host_reported" | "none";
  receipt_ref: SourceRef | null;
  recorded_at: number;
}

export interface BudgetSettleRequest {
  reservation_id: Id<"resv">;
  outcome: "succeeded" | "failed" | "cancelled" | "not_sent" | "unknown";
  provider_usage: ProviderUsage | null;
}

type BudgetSettlementReasonCode =
  | "usage_recorded"
  | "released_before_claim"
  | "usage_unknown"
  | "usage_partial";

export interface BudgetSettlement {
  reservation_id: Id<"resv">;
  state: "settled" | "released" | "unsettled";
  attempt_charges: number;
  input_token_charges: number | null;
  output_token_charges: number | null;
  cost_charges_micros: number | null;
  provider_usage: ProviderUsage | null;
  overage: boolean;
  reason_code: BudgetSettlementReasonCode;
}

/* ------------------------------------------------------------------ */
/* Run budget                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Reservation                                                         */
/* ------------------------------------------------------------------ */

interface ReservationAllowance {
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number | null;
  cost_status: CostStatus;
  pricing_known: boolean;
}

export interface ReservePlan {
  allowance: ReservationAllowance;
  expires_at: number;
}

/**
 * Computes the allowance a `reserve` call may hand out.
 *
 * Admission never invents a profile: `source="unknown"` yields
 * `cost_status="unknown"` with a `null` cost allowance, and the claim path
 * refuses paid calls. Known pricing caps the cost allowance at the policy
 * `max_cost_micros` when that cap is set.
 */
export function planReservation(input: {
  scope: BudgetScopePolicy;
  limits: ServiceProfileLimits;
  input_tokens_requested: number;
  output_tokens_requested: number;
  reservation_ttl_ms: number;
  now: number;
}): Result<ReservePlan, ErrorEnvelope> {
  const { scope, limits } = input;
  if (!isSafeNonNegativeInteger(input.input_tokens_requested)) {
    return err(reserveInconsistent("input_tokens_requested", "non_negative_safe_integer"));
  }
  if (!isSafeNonNegativeInteger(input.output_tokens_requested)) {
    return err(reserveInconsistent("output_tokens_requested", "non_negative_safe_integer"));
  }
  if (input.input_tokens_requested > scope.max_input_tokens) {
    return err(reserveInconsistent("input_tokens_requested", "max_input_tokens"));
  }
  if (input.output_tokens_requested > scope.max_output_tokens) {
    return err(reserveInconsistent("output_tokens_requested", "max_output_tokens"));
  }
  if (input.input_tokens_requested + input.output_tokens_requested > scope.request_max_tokens) {
    return err(reserveInconsistent("request_max_tokens", "input_plus_output"));
  }
  let costStatus: CostStatus;
  let costAllowance: number | null;
  if (limits.source === "unknown") {
    const reason = limits.reason_code;
    if (reason !== "profile_missing" && reason !== "limits_unknown" && reason !== "pricing_unknown") {
      return err(serviceProfileUnknown("unregistered_reason"));
    }
    costStatus = "unknown";
    costAllowance = null;
  } else {
    if (input.input_tokens_requested > limits.request_max_tokens) {
      return err(reserveInconsistent("limits.request_max_tokens", "service_profile"));
    }
    if (input.output_tokens_requested > limits.max_output_tokens) {
      return err(reserveInconsistent("limits.max_output_tokens", "service_profile"));
    }
    if (limits.pricing.status === "known") {
      const computed = computeCostMicros(limits.pricing, {
        input_tokens: input.input_tokens_requested,
        output_tokens: input.output_tokens_requested
      });
      if (computed === 0) {
        // A provider whose published price is zero has no monetary cost to
        // reserve. Recording `known` with a zero allowance made claim treat
        // every free call as `cost_exhausted`; `not_applicable` keeps the
        // "not zero-cost CPU" distinction while allowing the call.
        costStatus = "not_applicable";
        costAllowance = null;
      } else if (scope.max_cost_micros === null) {
        return err(reserveInconsistent("max_cost_micros", "provider_proves_zero"));
      } else {
        costStatus = "known";
        costAllowance = Math.min(scope.max_cost_micros, computed);
      }
    } else {
      // Unknown pricing always records `unknown`; a paid call is blocked at
      // claim with `limits_unknown` and never treated as zero cost.
      costStatus = "unknown";
      costAllowance = null;
    }
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return err(schemaError("now", "epoch_ms", "budget_reserve"));
  }
  if (!Number.isSafeInteger(input.reservation_ttl_ms) || input.reservation_ttl_ms <= 0) {
    return err(budgetPolicyUnavailable("reservation_ttl_ms", "positive_safe_integer"));
  }
  return ok({
    allowance: {
      attempts: scope.max_attempts,
      input_tokens: scope.max_input_tokens,
      output_tokens: scope.max_output_tokens,
      cost_micros: costAllowance,
      cost_status: costStatus,
      pricing_known: costStatus === "known"
    },
    expires_at: input.now + input.reservation_ttl_ms
  });
}

/** Builds the in-memory reservation record for a freshly reserved plan. */
export function createReservation(input: {
  reservation_id: Id<"resv">;
  request: BudgetReserveRequest;
  plan: ReservePlan;
  now: number;
}): BudgetReservation {
  return {
    reservation_id: input.reservation_id,
    reservation_key: input.request.reservation_key,
    binding: input.request.binding,
    policy_version: "bpol/1",
    purpose: input.request.purpose,
    state: "reserved",
    attempts_remaining: input.plan.allowance.attempts,
    input_tokens_remaining: input.plan.allowance.input_tokens,
    output_tokens_remaining: input.plan.allowance.output_tokens,
    cost_micros_remaining: input.plan.allowance.cost_micros,
    cost_status: input.plan.allowance.cost_status,
    expires_at: input.plan.expires_at,
    created_at: input.now
  };
}

/* ------------------------------------------------------------------ */
/* Claim                                                               */
/* ------------------------------------------------------------------ */

interface ClaimEnvironment {
  /** Number of non-expired `claimed` reservations for the provider scope. */
  inflight: number;
  /** `null` when the provider limit is unknown and the local guard applies. */
  per_scope_limit: number | null;
  global_inflight: number;
  global_limit: number;
  /** Cooldown deadline in epoch ms; `null` when the scope is clear. */
  cooldown_until: number | null;
  now: number;
}

interface ClaimDecision {
  result: BudgetClaimResult;
  /** Reservation state after the claim; unchanged when blocked. */
  reservation: BudgetReservation;
  attempt_charge_amount: 1;
}

/**
 * Evaluates a claim against the reservation, the scope policy and the rate
 * limit state. The attempt charge is decided here but persisted by the caller
 * in the same transaction as the `claimed` transition.
 */
export function planClaim(input: {
  reservation: BudgetReservation;
  request: BudgetClaimRequest;
  scope: BudgetScopePolicy;
  environment: ClaimEnvironment;
  attempt_charge_id: Id<"chg">;
  /** Attempt ref recorded by the claim that moved this reservation to `claimed`. */
  previous_attempt_ref?: string | null;
}): Result<ClaimDecision, ErrorEnvelope> {
  const { reservation, request, scope, environment } = input;
  if (reservation.state === "claimed") {
    // Idempotent replay: only the same `(reservation_id, attempt_ref)` pair.
    if (input.previous_attempt_ref !== undefined && input.previous_attempt_ref === request.attempt_ref) {
      const replay = replayClaim(
        reservation,
        request,
        scope,
        input.attempt_charge_id,
        environment.now
      );
      if (replay !== null) {
        return ok(replay);
      }
    }
    return ok(blocked("attempt_exhausted", null, reservation));
  }
  if (reservation.state !== "reserved") {
    return ok(blocked("attempt_exhausted", null, reservation));
  }
  if (!isSafeNonNegativeInteger(request.input_tokens_estimated)) {
    return err(reserveInconsistent("input_tokens_estimated", "non_negative_safe_integer"));
  }
  if (!isSafeNonNegativeInteger(request.output_tokens_reserved)) {
    return err(reserveInconsistent("output_tokens_reserved", "non_negative_safe_integer"));
  }
  if (reservation.expires_at <= environment.now) {
    return ok(blocked("attempt_exhausted", null, { ...reservation, state: "expired" }));
  }
  if (reservation.attempts_remaining < 1) {
    return ok(blocked("attempt_exhausted", null, reservation));
  }
  if (
    request.input_tokens_estimated > reservation.input_tokens_remaining ||
    request.output_tokens_reserved > reservation.output_tokens_remaining
  ) {
    return ok(blocked("token_exhausted", null, reservation));
  }
  if (reservation.cost_status === "unknown") {
    return ok(blocked("limits_unknown", null, reservation));
  }
  if (reservation.cost_status === "known" && reservation.cost_micros_remaining === 0) {
    return ok(blocked("cost_exhausted", null, reservation));
  }
  if (environment.cooldown_until !== null && environment.cooldown_until > environment.now) {
    return ok(
      blocked("rate_limited", environment.cooldown_until - environment.now, reservation)
    );
  }
  const perScopeLimit = environment.per_scope_limit ?? 1;
  if (environment.inflight >= perScopeLimit) {
    return ok(blocked("concurrency_limited", null, reservation));
  }
  if (environment.global_inflight >= environment.global_limit) {
    return ok(blocked("concurrency_limited", null, reservation));
  }
  // `scope.wall_ms` is a duration, not an absolute deadline. Comparing the
  // request's epoch deadline with the duration capped every call at 180000 ms
  // after 1970, so the backend saw an already-expired deadline and every
  // generation attempt timed out before it could run.
  const effectiveDeadline = Math.min(request.deadline_ms, environment.now + scope.wall_ms);
  if (
    !Number.isSafeInteger(request.deadline_ms) ||
    effectiveDeadline - environment.now < scope.min_work_ms
  ) {
    return ok(blocked("deadline_too_short", null, reservation));
  }
  const claimed: BudgetReservation = {
    ...reservation,
    state: "claimed",
    attempts_remaining: reservation.attempts_remaining - 1
  };
  return ok({
    result: {
      state: "claimed",
      reservation: claimed,
      attempt_charge_id: input.attempt_charge_id,
      effective_deadline_ms: effectiveDeadline
    },
    reservation: claimed,
    attempt_charge_amount: 1
  });
}

function replayClaim(
  reservation: BudgetReservation,
  request: BudgetClaimRequest,
  scope: BudgetScopePolicy,
  attemptChargeId: Id<"chg">,
  now: number
): ClaimDecision | null {
  if (request.attempt_ref.length === 0) {
    return null;
  }
  const effectiveDeadline = Math.min(request.deadline_ms, now + scope.wall_ms);
  if (!Number.isSafeInteger(request.deadline_ms) || effectiveDeadline - now < scope.min_work_ms) {
    return null;
  }
  return {
    result: {
      state: "claimed",
      reservation,
      attempt_charge_id: attemptChargeId,
      effective_deadline_ms: effectiveDeadline
    },
    reservation,
    attempt_charge_amount: 1
  };
}

function blocked(
  reason: BudgetClaimBlockedReason,
  retryAfterMs: number | null,
  reservation: BudgetReservation
): ClaimDecision {
  return {
    result: { state: "blocked", reason_code: reason, retry_after_ms: retryAfterMs },
    reservation,
    attempt_charge_amount: 1
  };
}

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

interface SettlementPlan {
  settlement: BudgetSettlement;
  reservation: BudgetReservation;
  overage_charge: { kind: "input_token" | "output_token" | "cost_micros"; amount: number } | null;
}

/**
 * Settles a reservation against provider usage (DD-FND-081).
 *
 * Known usage charges the actual amount and releases the unused allowance.
 * Unknown usage never releases to zero: the reservation becomes `unsettled`
 * and the missing axis stays `null`. Actual usage above the allowance is
 * reported as `overage` instead of being truncated.
 */
export function planSettlement(input: {
  reservation: BudgetReservation;
  request: BudgetSettleRequest;
  scope: BudgetScopePolicy;
}): Result<SettlementPlan, ErrorEnvelope> {
  const { reservation, request } = input;
  if (reservation.state === "settled" || reservation.state === "released") {
    return ok({
      settlement: {
        reservation_id: reservation.reservation_id,
        state: reservation.state === "settled" ? "settled" : "released",
        attempt_charges: 0,
        input_token_charges: null,
        output_token_charges: null,
        cost_charges_micros: null,
        provider_usage: null,
        overage: false,
        reason_code:
          reservation.state === "settled" ? "usage_recorded" : "released_before_claim"
      },
      reservation,
      overage_charge: null
    });
  }
  if (reservation.state === "reserved") {
    if (request.outcome !== "not_sent") {
      return err(reserveInconsistent("outcome", "not_sent_for_unclaimed"));
    }
    return ok({
      settlement: {
        reservation_id: reservation.reservation_id,
        state: "released",
        attempt_charges: 0,
        input_token_charges: null,
        output_token_charges: null,
        cost_charges_micros: null,
        provider_usage: null,
        overage: false,
        reason_code: "released_before_claim"
      },
      reservation: { ...reservation, state: "released" },
      overage_charge: null
    });
  }
  if (request.outcome === "not_sent") {
    return err(reserveInconsistent("outcome", "not_sent_after_claim"));
  }
  const attemptCharges = Math.max(0, input.scope.max_attempts - reservation.attempts_remaining);
  const usage = request.provider_usage;
  if (usage === null || usage.source === "none") {
    return ok({
      settlement: {
        reservation_id: reservation.reservation_id,
        state: "unsettled",
        attempt_charges: attemptCharges,
        input_token_charges: null,
        output_token_charges: null,
        cost_charges_micros: null,
        provider_usage: usage,
        overage: false,
        reason_code: "usage_unknown"
      },
      reservation: { ...reservation, state: "unsettled" },
      overage_charge: null
    });
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const costMicros = usage.cost_status === "known" ? usage.cost_micros : null;
  const partial =
    inputTokens === null ||
    outputTokens === null ||
    usage.cost_status === "unknown" ||
    (usage.cost_status === "known" && costMicros === null);
  const overage = detectOverage(reservation, inputTokens, outputTokens, costMicros);
  const state: BudgetSettlement["state"] = partial ? "unsettled" : "settled";
  const settlement: BudgetSettlement = {
    reservation_id: reservation.reservation_id,
    state,
    attempt_charges: attemptCharges,
    input_token_charges: inputTokens,
    output_token_charges: outputTokens,
    cost_charges_micros: costMicros,
    provider_usage: usage,
    overage: overage !== null,
    reason_code: partial ? "usage_partial" : "usage_recorded"
  };
  const next: BudgetReservation = {
    ...reservation,
    state,
    input_tokens_remaining:
      inputTokens === null
        ? reservation.input_tokens_remaining
        : Math.max(0, reservation.input_tokens_remaining - inputTokens),
    output_tokens_remaining:
      outputTokens === null
        ? reservation.output_tokens_remaining
        : Math.max(0, reservation.output_tokens_remaining - outputTokens),
    cost_micros_remaining:
      costMicros === null
        ? reservation.cost_micros_remaining
        : Math.max(0, (reservation.cost_micros_remaining ?? 0) - costMicros)
  };
  return ok({ settlement, reservation: next, overage_charge: overage });
}

function detectOverage(
  reservation: BudgetReservation,
  inputTokens: number | null,
  outputTokens: number | null,
  costMicros: number | null
): SettlementPlan["overage_charge"] {
  if (inputTokens !== null && inputTokens > reservation.input_tokens_remaining) {
    return { kind: "input_token", amount: inputTokens - reservation.input_tokens_remaining };
  }
  if (outputTokens !== null && outputTokens > reservation.output_tokens_remaining) {
    return { kind: "output_token", amount: outputTokens - reservation.output_tokens_remaining };
  }
  if (costMicros !== null && costMicros > (reservation.cost_micros_remaining ?? 0)) {
    return { kind: "cost_micros", amount: costMicros - (reservation.cost_micros_remaining ?? 0) };
  }
  return null;
}

/** Cost in integer micro-USD, rounded up so a call is never under-charged. */
function computeCostMicros(
  pricing: {
    status: "known";
    input_micros_per_million: number;
    output_micros_per_million: number;
    fixed_micros: number;
  },
  tokens: { input_tokens: number; output_tokens: number }
): number {
  const input = (tokens.input_tokens * pricing.input_micros_per_million) / 1_000_000;
  const output = (tokens.output_tokens * pricing.output_micros_per_million) / 1_000_000;
  return Math.ceil(input + output + pricing.fixed_micros);
}

/* ------------------------------------------------------------------ */
/* Persistence hooks                                                   */
/* ------------------------------------------------------------------ */

interface ReservationRow extends Record<string, unknown> {
  reservation_id: string;
  reservation_key: string;
  policy_version: string;
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  purpose: string;
  state: string;
  attempt_allowance: number;
  input_token_allowance: number;
  output_token_allowance: number;
  cost_allowance_micros: number | null;
  cost_status: string;
  created_at: number;
  expires_at: number;
}

/**
 * Reads one reservation row inside the caller's transaction.
 *
 * @throws never — returns `E_BUDGET_RESERVE_INCONSISTENT` for malformed rows.
 */
export function readReservationInTransaction(
  tx: Tx,
  reservationId: Id<"resv">
): Result<BudgetReservation, ErrorEnvelope> {
  const row = tx
    .prepare<ReservationRow>(
      "SELECT * FROM budget_reservation WHERE reservation_id = ?"
    )
    .get([reservationId]);
  if (row === undefined) {
    return err(reserveInconsistent("reservation_id", "not_found"));
  }
  return decodeReservationRow(row);
}

/**
 * True when the scope holds an `unsettled` reservation.
 *
 * A new paid `reserve` on such a scope is blocked with
 * `blocked/budget_unsettled` until a receipt or explicit reconciliation
 * arrives.
 */
export function hasUnsettledReservationInTransaction(tx: Tx, scopeKey: string): boolean {
  const row = tx
    .prepare<{ present: number }>(
      "SELECT 1 AS present FROM budget_reservation WHERE scope_key = ? AND state = 'unsettled' LIMIT 1"
    )
    .get([scopeKey]);
  return row !== undefined;
}

function decodeReservationRow(row: ReservationRow): Result<BudgetReservation, ErrorEnvelope> {
  if (row.policy_version !== "bpol/1") {
    return err(reserveInconsistent("policy_version", "bpol/1"));
  }
  if (!isReservationState(row.state)) {
    return err(reserveInconsistent("state", "reservation_state"));
  }
  if (!isCostStatus(row.cost_status)) {
    return err(reserveInconsistent("cost_status", "cost_status"));
  }
  const purpose = row.purpose;
  if (!isBudgetPurpose(purpose)) {
    return err(reserveInconsistent("purpose", "registered_purpose"));
  }
  if (!isId(row.reservation_id, "resv")) {
    return err(reserveInconsistent("reservation_id", "resv_id"));
  }
  if (!isId(row.task_id, "task") || !isId(row.branch_id, "br")) {
    return err(reserveInconsistent("binding", "version_binding_ids"));
  }
  return ok({
    reservation_id: row.reservation_id,
    reservation_key: row.reservation_key,
    binding: {
      task_id: row.task_id,
      branch_id: row.branch_id,
      input_epoch: row.input_epoch,
      goal_version: row.goal_version,
      config_version: row.config_version,
      watermark: row.watermark
    },
    policy_version: "bpol/1",
    purpose,
    state: row.state,
    attempts_remaining: row.attempt_allowance,
    input_tokens_remaining: row.input_token_allowance,
    output_tokens_remaining: row.output_token_allowance,
    cost_micros_remaining: row.cost_allowance_micros,
    cost_status: row.cost_status,
    expires_at: row.expires_at,
    created_at: row.created_at
  });
}

function isReservationState(value: string): value is BudgetReservationState {
  return (
    value === "reserved" ||
    value === "claimed" ||
    value === "settled" ||
    value === "released" ||
    value === "expired" ||
    value === "unsettled"
  );
}

function isCostStatus(value: string): value is CostStatus {
  return value === "known" || value === "unknown" || value === "not_applicable";
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
