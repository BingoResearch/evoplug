/**
 * Budget planning seams for verifier calls and non-applicable cost samples
 * (DD-FND-080, DD-FND-081).
 *
 * A verifier call may contain several stages, but it owns exactly one
 * `verifier` reservation. Work that performs no external process, network or
 * paid-model call never creates a reservation: its cost is `not_applicable`
 * with null amounts, which is not the same as zero cost.
 */

import type { ErrorEnvelope, Id, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { schemaError } from "./errors.js";
import type { BudgetScopePolicy } from "./policy.js";
import { planReservation } from "./reservation.js";
import type { ReservePlan, ServiceProfileLimits } from "./reservation.js";

/** One stage of a single verifier invocation. */
export interface VerifierStageRequest {
  /** Stable stage name; recorded only for diagnostics, never charged separately. */
  readonly stage: string;
  readonly input_tokens_requested: number;
  readonly output_tokens_requested: number;
}

export interface VerifierReservationPlan {
  readonly purpose: "verifier";
  readonly stage_count: number;
  /** Sum of the stages, admitted against the single verifier reservation. */
  readonly input_tokens_requested: number;
  readonly output_tokens_requested: number;
  readonly reservation: ReservePlan;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Plans one `verifier` reservation for a multi-stage verification call.
 *
 * All stages share the same reservation and the same allowance; the planner
 * sums their token requests and defers admission limits to `planReservation`.
 */
export function planVerifierReservation(input: {
  readonly scope: BudgetScopePolicy;
  readonly limits: ServiceProfileLimits;
  readonly stages: readonly VerifierStageRequest[];
  readonly reservation_ttl_ms: number;
  readonly now: number;
}): Result<VerifierReservationPlan, ErrorEnvelope> {
  if (input.scope.purpose !== "verifier") {
    return err(schemaError("scope.purpose", "verifier", "budget_reserve"));
  }
  if (input.stages.length === 0) {
    return err(schemaError("stages", "non_empty", "budget_reserve"));
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const stage of input.stages) {
    if (stage.stage.length === 0) {
      return err(schemaError("stages.stage", "non_empty", "budget_reserve"));
    }
    if (!isSafeNonNegativeInteger(stage.input_tokens_requested)) {
      return err(schemaError("stages.input_tokens_requested", "non_negative_safe_integer", "budget_reserve"));
    }
    if (!isSafeNonNegativeInteger(stage.output_tokens_requested)) {
      return err(schemaError("stages.output_tokens_requested", "non_negative_safe_integer", "budget_reserve"));
    }
    inputTokens += stage.input_tokens_requested;
    outputTokens += stage.output_tokens_requested;
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
      return err(schemaError("stages", "token_sum_overflow", "budget_reserve"));
    }
  }
  const reservation = planReservation({
    scope: input.scope,
    limits: input.limits,
    input_tokens_requested: inputTokens,
    output_tokens_requested: outputTokens,
    reservation_ttl_ms: input.reservation_ttl_ms,
    now: input.now,
  });
  if (!reservation.ok) {
    return reservation;
  }
  return ok({
    purpose: "verifier",
    stage_count: input.stages.length,
    input_tokens_requested: inputTokens,
    output_tokens_requested: outputTokens,
    reservation: reservation.value,
  });
}

/** Why a sample has no external work and therefore no reservation. */
export type NotApplicableCostReason =
  | "existing_result"
  | "local_pure_check"
  | "deterministic_rule";

export interface NotApplicableCostPlan {
  readonly reservation_required: false;
  readonly reservation_ids: readonly Id<"resv">[];
  readonly input_tokens: null;
  readonly output_tokens: null;
  readonly cost_micros: null;
  readonly cost_status: "not_applicable";
  readonly cost_complete: true;
  readonly reason: NotApplicableCostReason;
}

/**
 * Describes a sample that performs no external or paid work.
 *
 * Amounts stay null: `not_applicable` must never be read as zero tokens, zero
 * CPU time or zero total cost.
 */
export function planNotApplicableCost(reason: NotApplicableCostReason): NotApplicableCostPlan {
  return {
    reservation_required: false,
    reservation_ids: [],
    input_tokens: null,
    output_tokens: null,
    cost_micros: null,
    cost_status: "not_applicable",
    cost_complete: true,
    reason,
  };
}
