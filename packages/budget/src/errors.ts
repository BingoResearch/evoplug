/**
 * Budget error envelopes.
 *
 * Codes and detail branches are the ones the design names for FND budget
 * (DD-FND-034, DD-FND-080.1, DD-FND-081). No code is invented locally and no
 * budget failure is reported as a provider cost.
 */

import { newId } from "@evoplug/core";
import type { ErrorCode, ErrorDetails, ErrorEnvelope, Hash, Id, SourceRef } from "@evoplug/core";

export type BudgetErrorCode =
  | "E_BUDGET_POLICY_UNAVAILABLE"
  | "E_BUDGET_RESERVE_INCONSISTENT"
  | "E_BUDGET_EXCEEDED"
  | "E_SERVICE_PROFILE_UNKNOWN"
  | "E_SERVICE_PROFILE_MISMATCH"
  | "E_SERVICE_PROFILE_BLOCKED"
  | "E_LEDGER_ASOF_UNAVAILABLE"
  | "E_VERSION_BINDING"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_SCHEMA"
  | "E_STORAGE_BUSY"
  | "E_STORAGE_IO";

const CATEGORY_BY_CODE: Readonly<Record<BudgetErrorCode, ErrorEnvelope["category"]>> = {
  E_BUDGET_POLICY_UNAVAILABLE: "policy",
  E_BUDGET_RESERVE_INCONSISTENT: "budget",
  E_BUDGET_EXCEEDED: "budget",
  E_SERVICE_PROFILE_UNKNOWN: "policy",
  E_SERVICE_PROFILE_MISMATCH: "version",
  E_SERVICE_PROFILE_BLOCKED: "policy",
  E_LEDGER_ASOF_UNAVAILABLE: "storage",
  E_VERSION_BINDING: "version",
  E_IDEMPOTENCY_CONFLICT: "conflict",
  E_SCHEMA: "schema",
  E_STORAGE_BUSY: "storage",
  E_STORAGE_IO: "storage"
};

const RETRYABLE_BY_CODE: Readonly<Record<BudgetErrorCode, boolean>> = {
  E_BUDGET_POLICY_UNAVAILABLE: false,
  E_BUDGET_RESERVE_INCONSISTENT: false,
  E_BUDGET_EXCEEDED: false,
  E_SERVICE_PROFILE_UNKNOWN: false,
  E_SERVICE_PROFILE_MISMATCH: false,
  E_SERVICE_PROFILE_BLOCKED: false,
  E_LEDGER_ASOF_UNAVAILABLE: false,
  E_VERSION_BINDING: false,
  E_IDEMPOTENCY_CONFLICT: false,
  E_SCHEMA: false,
  E_STORAGE_BUSY: true,
  E_STORAGE_IO: false
};

export interface BudgetErrorInput {
  readonly code: BudgetErrorCode;
  readonly stage: string;
  readonly details: ErrorDetails;
  readonly trace_id?: Id<"ipc">;
  readonly retryable?: boolean;
  readonly detail_ref?: SourceRef;
  readonly retry_after_ms?: number;
}

/** Builds a budget `ErrorEnvelope` with the per-code registry defaults. */
export function budgetError(input: BudgetErrorInput): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code: input.code,
    category: CATEGORY_BY_CODE[input.code],
    retryable: input.retryable ?? RETRYABLE_BY_CODE[input.code],
    side_effect: "none",
    message_key: `error.${input.code.toLowerCase()}`,
    details: input.details,
    stage: input.stage,
    trace_id: input.trace_id ?? newId("ipc")
  };
  if (input.detail_ref !== undefined) {
    envelope.detail_ref = input.detail_ref;
  }
  if (input.retry_after_ms !== undefined) {
    envelope.retry_after_ms = input.retry_after_ms;
  }
  return envelope;
}

/** `details.kind="budget"` (DD-FND-034). */
export function budgetDetails(input: {
  scope_key: string;
  policy_version: string;
  budget_kind: "token" | "cost" | "attempt" | "rate" | "deadline";
  remaining: number | null;
}): ErrorDetails {
  return {
    kind: "budget",
    scope_key: input.scope_key,
    policy_version: input.policy_version,
    budget_kind: input.budget_kind,
    remaining: input.remaining
  };
}

/** `details.kind="field"`. */
export function fieldDetails(path: string, rule: string): ErrorDetails {
  return { kind: "field", path, rule };
}

/** `details.kind="none"`. */
export function noneDetails(): ErrorDetails {
  return { kind: "none" };
}

/** `details.kind="conflict"`. */
export function conflictDetails(currentHash: Hash, expectedHash: Hash): ErrorDetails {
  return { kind: "conflict", current_hash: currentHash, expected_hash: expectedHash };
}

/** Maps an allowance-charge unit onto the narrower `budget` detail axis. */
export function budgetKindForUnit(
  unit: "attempt" | "input_token" | "output_token" | "cost_micros" | "wall_ms"
): "token" | "cost" | "attempt" | "rate" | "deadline" {
  switch (unit) {
    case "attempt":
      return "attempt";
    case "input_token":
    case "output_token":
      return "token";
    case "cost_micros":
      return "cost";
    case "wall_ms":
      return "deadline";
    default: {
      const exhaustive: never = unit;
      return exhaustive;
    }
  }
}

/** Fixed `E_BUDGET_POLICY_UNAVAILABLE` failure (DD-FND-080.1). */
export function budgetPolicyUnavailable(
  path: string,
  rule: string,
  stage = "budget_policy_read"
): ErrorEnvelope {
  return budgetError({
    code: "E_BUDGET_POLICY_UNAVAILABLE",
    stage,
    details: fieldDetails(path, rule)
  });
}

/** Malformed request or stored row on the reserve/claim/settle path. */
export function reserveInconsistent(path: string, rule: string): ErrorEnvelope {
  return budgetError({
    code: "E_BUDGET_RESERVE_INCONSISTENT",
    stage: "budget_reserve",
    details: fieldDetails(path, rule)
  });
}

/** Schema-level rejection. */
export function schemaError(path: string, rule: string, stage = "schema_validate"): ErrorEnvelope {
  return budgetError({ code: "E_SCHEMA", stage, details: fieldDetails(path, rule) });
}

export function serviceProfileUnknown(reason: string): ErrorEnvelope {
  return budgetError({
    code: "E_SERVICE_PROFILE_UNKNOWN",
    stage: "budget_reserve",
    details: fieldDetails("limits.reason_code", reason)
  });
}

export function versionBindingError(path: string): ErrorEnvelope {
  return budgetError({
    code: "E_VERSION_BINDING",
    stage: "binding",
    details: { kind: "version", expected: "version_binding", actual: path }
  });
}

export function ledgerAsofUnavailable(operation: string): ErrorEnvelope {
  return budgetError({
    code: "E_LEDGER_ASOF_UNAVAILABLE",
    stage: "budget_actuals_read",
    details: { kind: "storage", operation }
  });
}

/** True when `code` belongs to the budget package's closed set. */
export function isBudgetErrorCode(code: ErrorCode): code is BudgetErrorCode {
  return Object.prototype.hasOwnProperty.call(CATEGORY_BY_CODE, code);
}
