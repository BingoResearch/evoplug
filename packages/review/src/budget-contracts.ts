/**
 * FND budget ABI consumed by REV (DD-REV-033, DD-FND-080).
 *
 * `@evoplug/budget` owns these records. They are mirrored structurally here
 * because the review package does not declare a dependency on the budget
 * package; the integration phase should replace these imports with
 * `@evoplug/budget` exports. No field is renamed.
 */

import type { ErrorEnvelope, Hash, Id, Result, SourceRef, Tx, VersionBinding } from "@evoplug/core";

import type { HostId, HostMode } from "./host-contracts.js";

export type CostStatus = "known" | "unknown" | "not_applicable";

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

export interface BudgetReserveRequestLike {
  reservation_key: string;
  binding: VersionBinding;
  purpose: "review_generate";
  scope_key: string;
  service_profile_id: string;
  provider_scope: string;
  limits: ServiceProfileLimits;
  input_tokens_requested: number;
  output_tokens_requested: number;
  deadline_ms: number;
}

export type BudgetReservationState =
  | "reserved"
  | "claimed"
  | "settled"
  | "released"
  | "expired"
  | "unsettled";

export interface BudgetReservationLike {
  reservation_id: Id<"resv">;
  reservation_key: string;
  binding: VersionBinding;
  policy_version: "bpol/1";
  purpose: "review_generate";
  state: BudgetReservationState;
  attempts_remaining: number;
  input_tokens_remaining: number;
  output_tokens_remaining: number;
  cost_micros_remaining: number | null;
  cost_status: CostStatus;
  expires_at: number;
  created_at: number;
}

export interface BudgetClaimRequestLike {
  reservation_id: Id<"resv">;
  attempt_ref: string;
  input_tokens_estimated: number;
  output_tokens_reserved: number;
  counting_method_version: "rsi.review_count/1";
  deadline_ms: number;
}

export type BudgetClaimBlockedReasonLike =
  | "attempt_exhausted"
  | "token_exhausted"
  | "cost_exhausted"
  | "rate_limited"
  | "concurrency_limited"
  | "deadline_too_short"
  | "budget_unsettled"
  | "limits_unknown";

export type BudgetClaimResultLike =
  | {
      state: "claimed";
      reservation: BudgetReservationLike;
      attempt_charge_id: Id<"chg">;
      effective_deadline_ms: number;
    }
  | {
      state: "blocked";
      reason_code: BudgetClaimBlockedReasonLike;
      retry_after_ms: number | null;
    };

export interface ProviderUsageLike {
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

export interface BudgetSettleRequestLike {
  reservation_id: Id<"resv">;
  outcome: "succeeded" | "failed" | "cancelled" | "not_sent" | "unknown";
  provider_usage: ProviderUsageLike | null;
}

export interface BudgetSettlementLike {
  reservation_id: Id<"resv">;
  state: "settled" | "released" | "unsettled";
  attempt_charges: number;
  input_token_charges: number | null;
  output_token_charges: number | null;
  cost_charges_micros: number | null;
  provider_usage: ProviderUsageLike | null;
  overage: boolean;
  reason_code: "usage_recorded" | "released_before_claim" | "usage_unknown" | "usage_partial";
}

export interface BudgetScopePolicyLike {
  purpose: "review_generate";
  max_attempts: number;
  max_input_tokens: number;
  max_output_tokens: number;
  request_max_tokens: number;
  question_max_tokens: number;
  request_margin_tokens: number;
  question_margin_tokens: number;
  max_cost_micros: number | null;
  wall_ms: number;
  reserve_ms: number;
  min_work_ms: number;
  attempt_charge_at: "claim";
  attempt_refundable: false;
}

export interface BudgetScopePolicyViewLike {
  schema_version: "rsi.budget_scope_policy_view/1";
  budget_policy_ref: string;
  budget_policy_version: "bpol/1";
  content_hash: Hash;
  scope: BudgetScopePolicyLike;
}

export interface BudgetPolicyReadPortLike {
  getScopeInTransaction(
    tx: Tx,
    input: { budget_policy_ref: string; purpose: "review_generate" }
  ): Result<BudgetScopePolicyViewLike, ErrorEnvelope>;
}

/** FND budget ledger service used by the C2/C3/settle steps. */
export interface BudgetLedgerPort {
  reserve(request: BudgetReserveRequestLike): Promise<Result<BudgetReservationLike, ErrorEnvelope>>;
  claim(request: BudgetClaimRequestLike): Promise<Result<BudgetClaimResultLike, ErrorEnvelope>>;
  settle(request: BudgetSettleRequestLike): Promise<Result<BudgetSettlementLike, ErrorEnvelope>>;
}

/** HOST version facts used by lifecycle evaluation. */
export interface HostLifecycleFacts {
  host_id: HostId;
  mode: HostMode;
  host_version: string;
  tool_versions: Record<string, string>;
  model_family: string;
  facts_hash: Hash;
  evidence_ref: SourceRef;
}
