/**
 * The two budget ledgers and the actuals read port (DD-FND-081).
 *
 * `AllowanceCharge` records local quota consumption; `ProviderUsage` records
 * what the provider reported. They are never merged, and an unknown amount is
 * `null`, never `0`.
 */

import type {
  ErrorEnvelope,
  Id,
  Result,
  SourceRef,
  Tx,
  VersionBinding,
} from "@evoplug/core";
import { compareUtf8, err, isId, isSourceRef, ok } from "@evoplug/core";

import { ledgerAsofUnavailable, reserveInconsistent, versionBindingError } from "./errors.js";
import type { CostStatus, ProviderUsage } from "./reservation.js";
import { readReservationInTransaction } from "./reservation.js";

export const ALLOWANCE_CHARGE_SCHEMA_VERSION: "rsi.allowance_charge/1" = "rsi.allowance_charge/1";

export const PROVIDER_USAGE_SCHEMA_VERSION: "rsi.provider_usage/1" = "rsi.provider_usage/1";

export const BUDGET_ACTUALS_SCHEMA_VERSION: "rsi.budget_actuals/1" = "rsi.budget_actuals/1";

export type AllowanceChargeKind = "attempt" | "input_token" | "output_token" | "cost_micros" | "wall_ms";

export type AllowanceChargeReason = "claim" | "retry" | "usage_actual" | "overage" | "expiry_hold";

export interface AllowanceCharge {
  schema_version: "rsi.allowance_charge/1";
  charge_id: Id<"chg">;
  charge_key: string;
  reservation_id: Id<"resv">;
  kind: AllowanceChargeKind;
  /** Integer amount in the unit named by `kind`; `attempt` is always 1. */
  amount: number;
  non_refundable: boolean;
  reason: AllowanceChargeReason;
  charged_at: number;
}

export interface BudgetActualsView {
  schema_version: "rsi.budget_actuals/1";
  binding: VersionBinding;
  /** Ascending UTF-8, deduplicated, 0..8 entries. `[]` means no paid call. */
  reservation_ids: readonly Id<"resv">[];
  /** Ascending by `usage_key` UTF-8. */
  provider_usage: readonly ProviderUsage[];
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: CostStatus;
  cost_complete: boolean;
  /** Ascending UTF-8, deduplicated. */
  receipts: readonly SourceRef[];
}

export interface BudgetActualsReadPort {
  readActuals(q: {
    binding: VersionBinding;
    reservation_ids: readonly Id<"resv">[];
  }): Promise<Result<BudgetActualsView, ErrorEnvelope>>;
}

/** Upper bound on the reservation ids a route/attempt may report. */
export const MAX_ACTUALS_RESERVATIONS = 8;

/**
 * Builds the local `claim` charge.
 *
 * The attempt charge is `amount=1` and `non_refundable=true`: `bpol/1` never
 * refunds a failed, cancelled or timed-out attempt.
 */
export function makeClaimCharge(input: {
  charge_id: Id<"chg">;
  charge_key: string;
  reservation_id: Id<"resv">;
  charged_at: number;
}): AllowanceCharge {
  return {
    schema_version: ALLOWANCE_CHARGE_SCHEMA_VERSION,
    charge_id: input.charge_id,
    charge_key: input.charge_key,
    reservation_id: input.reservation_id,
    kind: "attempt",
    amount: 1,
    non_refundable: true,
    reason: "claim",
    charged_at: input.charged_at
  };
}

/** Builds an `usage_actual` charge for a settled known usage. */
export function makeUsageCharge(input: {
  charge_id: Id<"chg">;
  charge_key: string;
  reservation_id: Id<"resv">;
  kind: Exclude<AllowanceChargeKind, "attempt">;
  amount: number;
  charged_at: number;
}): AllowanceCharge {
  return {
    schema_version: ALLOWANCE_CHARGE_SCHEMA_VERSION,
    charge_id: input.charge_id,
    charge_key: input.charge_key,
    reservation_id: input.reservation_id,
    kind: input.kind,
    amount: input.amount,
    non_refundable: true,
    reason: "usage_actual",
    charged_at: input.charged_at
  };
}

/** Builds an `overage` charge; the amount is never clamped to the allowance. */
export function makeOverageCharge(input: {
  charge_id: Id<"chg">;
  charge_key: string;
  reservation_id: Id<"resv">;
  kind: Exclude<AllowanceChargeKind, "attempt">;
  amount: number;
  charged_at: number;
}): AllowanceCharge {
  return {
    schema_version: ALLOWANCE_CHARGE_SCHEMA_VERSION,
    charge_id: input.charge_id,
    charge_key: input.charge_key,
    reservation_id: input.reservation_id,
    kind: input.kind,
    amount: input.amount,
    non_refundable: true,
    reason: "overage",
    charged_at: input.charged_at
  };
}

/**
 * Validates the closed `ProviderUsage` invariants before it is persisted.
 *
 * `host_reported` and `provider_receipt` require a receipt; a known cost needs
 * a non-null amount; an unknown cost must keep the amount `null`.
 */
export function validateProviderUsage(usage: ProviderUsage): Result<ProviderUsage, ErrorEnvelope> {
  if (usage.source === "none") {
    if (usage.cost_status === "known" || usage.cost_micros !== null) {
      return err(reserveInconsistent("provider_usage", "none_source_unknown_cost"));
    }
  } else if (usage.receipt_ref === null) {
    return err(reserveInconsistent("provider_usage.receipt_ref", "required_for_receipt_source"));
  }
  if (usage.cost_status === "known" && usage.cost_micros === null) {
    return err(reserveInconsistent("provider_usage.cost_micros", "required_when_known"));
  }
  if (usage.cost_status === "unknown" && usage.cost_micros !== null) {
    return err(reserveInconsistent("provider_usage.cost_micros", "null_when_unknown"));
  }
  for (const [field, value] of [
    ["input_tokens", usage.input_tokens],
    ["output_tokens", usage.output_tokens],
    ["cost_micros", usage.cost_micros]
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      return err(reserveInconsistent(`provider_usage.${field}`, "non_negative_safe_integer"));
    }
  }
  return ok(usage);
}

/**
 * Reads actuals inside the caller's read transaction (DD-FND-081).
 *
 * Every step is fail-closed: the id set must already be sorted, unique and at
 * most eight entries; each reservation must exist and carry exactly the
 * requested six-field binding; every usage row must belong to the reservation.
 * Nothing is backfilled and no estimate is reported as actual cost.
 */
export function readActualsInTransaction(
  tx: Tx,
  q: { readonly binding: VersionBinding; readonly reservation_ids: readonly Id<"resv">[] }
): Result<BudgetActualsView, ErrorEnvelope> {
  const ids = q.reservation_ids;
  if (ids.length > MAX_ACTUALS_RESERVATIONS) {
    return err(ledgerAsofUnavailable("reservation_ids:max_8"));
  }
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === undefined || !isId(id, "resv")) {
      return err(ledgerAsofUnavailable("reservation_ids:invalid"));
    }
    if (seen.has(id)) {
      return err(ledgerAsofUnavailable("reservation_ids:duplicate"));
    }
    const previous = index === 0 ? null : ids[index - 1];
    if (previous !== null && previous !== undefined && compareUtf8(previous, id) >= 0) {
      return err(ledgerAsofUnavailable("reservation_ids:unordered"));
    }
    seen.add(id);
  }
  if (ids.length === 0) {
    return ok({
      schema_version: BUDGET_ACTUALS_SCHEMA_VERSION,
      binding: q.binding,
      reservation_ids: [],
      provider_usage: [],
      input_tokens: null,
      output_tokens: null,
      cost_micros: null,
      cost_status: "not_applicable",
      cost_complete: true,
      receipts: []
    });
  }
  const usages: ProviderUsage[] = [];
  let allSettled = true;
  let complete = true;
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let costMicros: number | null = 0;
  let anyUnknownCost = false;
  let anyModel = false;
  let allNotApplicable = true;
  for (const reservationId of ids) {
    const reservation = readReservationInTransaction(tx, reservationId);
    if (!reservation.ok) {
      return err(ledgerAsofUnavailable("budget_reservation:missing"));
    }
    if (!sameBinding(reservation.value.binding, q.binding)) {
      return err(versionBindingError("binding"));
    }
    if (reservation.value.state !== "settled") {
      allSettled = false;
      // A claimed or unsettled reservation has no complete receipt yet.
      complete = false;
    }
    const rows = readUsageRows(tx, reservationId);
    if (!rows.ok) {
      return rows;
    }
    if (reservation.value.purpose !== "egress_other") {
      anyModel = true;
    }
    for (const usage of rows.value) {
      usages.push(usage);
      if (usage.source === "none" || usage.receipt_ref === null) {
        complete = false;
      }
      if (usage.cost_status === "unknown") {
        anyUnknownCost = true;
        allNotApplicable = false;
      } else if (usage.cost_status === "known") {
        allNotApplicable = false;
      }
      inputTokens = accumulate(inputTokens, usage.input_tokens);
      outputTokens = accumulate(outputTokens, usage.output_tokens);
      costMicros = accumulate(costMicros, usage.cost_micros);
    }
  }
  usages.sort((left, right) => compareUtf8(left.usage_key, right.usage_key));
  const receipts = dedupeSorted(
    usages
      .map((usage) => usage.receipt_ref)
      .filter((ref): ref is SourceRef => ref !== null)
  );
  let costStatus: CostStatus;
  if (anyUnknownCost) {
    costStatus = "unknown";
    costMicros = null;
  } else if (allNotApplicable && !anyModel) {
    costStatus = "not_applicable";
    costMicros = null;
  } else {
    costStatus = allSettled && complete ? "known" : "unknown";
    if (costStatus === "unknown") {
      costMicros = null;
    }
  }
  if (!complete) {
    inputTokens = null;
    outputTokens = null;
  }
  return ok({
    schema_version: BUDGET_ACTUALS_SCHEMA_VERSION,
    binding: q.binding,
    reservation_ids: ids,
    provider_usage: usages,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_micros: costMicros,
    cost_status: costStatus,
    cost_complete: allSettled && complete,
    receipts
  });
}

interface UsageRow extends Record<string, unknown> {
  usage_key: string;
  attempt_ref: string | null;
  provider_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: string;
  source: string;
  receipt_ref: string | null;
  recorded_at: number;
}

function readUsageRows(
  tx: Tx,
  reservationId: Id<"resv">
): Result<readonly ProviderUsage[], ErrorEnvelope> {
  let rows: readonly UsageRow[];
  try {
    rows = tx
      .prepare<UsageRow>("SELECT * FROM provider_usage WHERE reservation_id = ? ORDER BY usage_key")
      .all([reservationId]);
  } catch {
    return err(ledgerAsofUnavailable("provider_usage:read"));
  }
  const usages: ProviderUsage[] = [];
  for (const row of rows) {
    const usage = decodeUsageRow(row);
    if (!usage.ok) {
      return usage;
    }
    usages.push(usage.value);
  }
  return ok(usages);
}

function decodeUsageRow(row: UsageRow): Result<ProviderUsage, ErrorEnvelope> {
  if (!isCostStatusValue(row.cost_status)) {
    return err(ledgerAsofUnavailable("provider_usage.cost_status"));
  }
  if (!isUsageSource(row.source)) {
    return err(ledgerAsofUnavailable("provider_usage.source"));
  }
  if (row.usage_key.length === 0 || row.attempt_ref === null) {
    return err(ledgerAsofUnavailable("provider_usage.identity"));
  }
  if (!Number.isSafeInteger(row.recorded_at) || row.recorded_at < 0) {
    return err(ledgerAsofUnavailable("provider_usage.recorded_at"));
  }
  for (const value of [row.input_tokens, row.output_tokens, row.cost_micros]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      return err(ledgerAsofUnavailable("provider_usage.amount"));
    }
  }
  let receiptRef: SourceRef | null = null;
  if (row.receipt_ref !== null) {
    if (!isSourceRef(row.receipt_ref)) {
      return err(ledgerAsofUnavailable("provider_usage.receipt_ref"));
    }
    receiptRef = row.receipt_ref;
  }
  const usage: ProviderUsage = {
    usage_key: row.usage_key,
    attempt_ref: row.attempt_ref,
    provider_request_id: row.provider_request_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_micros: row.cost_micros,
    cost_status: row.cost_status,
    source: row.source,
    receipt_ref: receiptRef,
    recorded_at: row.recorded_at
  };
  const checked = validateProviderUsage(usage);
  return checked.ok ? checked : err(ledgerAsofUnavailable("provider_usage.invariant"));
}

function isCostStatusValue(value: string): value is CostStatus {
  return value === "known" || value === "unknown" || value === "not_applicable";
}

function isUsageSource(value: string): value is ProviderUsage["source"] {
  return value === "provider_receipt" || value === "host_reported" || value === "none";
}

function sameBinding(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

function accumulate(total: number | null, value: number | null): number | null {
  if (total === null || value === null) {
    return null;
  }
  return total + value;
}

function dedupeSorted(values: readonly SourceRef[]): SourceRef[] {
  return [...new Set(values)].sort(compareUtf8);
}
