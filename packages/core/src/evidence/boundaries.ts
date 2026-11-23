/**
 * Owner-envelope boundaries (DD-QP-08, DD-QP-06).
 *
 * QP never reimplements owner validation. These functions unwrap only the
 * envelope shape, preserve the four allowed aggregate codes and the three
 * REV handoff codes, and map unknown shapes or codes to `E_SCHEMA` with the
 * owning path stage.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { Result } from "../result.js";
import type { AcceptedAggregateView, EvdError, ReviewHandoffCloseView } from "./ports.js";
import { isAcceptedAggregateCode, isHandoffCode } from "./errors.js";

function aggregateCode(
  code: string
): "E_AGGREGATE_NOT_FOUND" | "E_AGGREGATE_NOT_ACCEPTED" | "E_AGGREGATE_HASH_MISMATCH" | "E_SOURCE_UNRETRIEVABLE" | null {
  if (!isAcceptedAggregateCode(code)) {
    return null;
  }
  switch (code) {
    case "E_AGGREGATE_NOT_FOUND":
    case "E_AGGREGATE_NOT_ACCEPTED":
    case "E_AGGREGATE_HASH_MISMATCH":
    case "E_SOURCE_UNRETRIEVABLE":
      return code;
    default:
      return null;
  }
}

function handoffCode(
  code: string
): "E_HANDOFF_NOT_READY" | "E_HANDOFF_PAYLOAD_INVALID" | "E_HANDOFF_PROPOSAL_MISMATCH" | "E_SCHEMA" | null {
  if (!isHandoffCode(code) && code !== "E_SCHEMA") {
    return null;
  }
  switch (code) {
    case "E_HANDOFF_NOT_READY":
    case "E_HANDOFF_PAYLOAD_INVALID":
    case "E_HANDOFF_PROPOSAL_MISMATCH":
    case "E_SCHEMA":
      return code;
    default:
      return null;
  }
}

export type QpAggregateReadResult =
  | { status: "ok"; aggregate: AcceptedAggregateView }
  | {
      status: "rejected";
      code:
        | "E_AGGREGATE_NOT_FOUND"
        | "E_AGGREGATE_NOT_ACCEPTED"
        | "E_AGGREGATE_HASH_MISMATCH"
        | "E_SOURCE_UNRETRIEVABLE"
        | "E_SCHEMA";
      details: { stage: "aggregate_read"; upstream_code?: string };
    };

function aggregateShapeValid(value: AcceptedAggregateView): boolean {
  return (
    (value.schema_version === "rsi.answer_aggregate/1" || value.schema_version === "rsi.answer_aggregate/2") &&
    typeof value.aggregate_id === "string" &&
    typeof value.aggregate_key === "string" &&
    typeof value.aggregate_hash === "string" &&
    typeof value.issue_id === "string" &&
    typeof value.plan_id === "string" &&
    typeof value.plan_hash === "string" &&
    Array.isArray(value.propositions)
  );
}

/**
 * Unwraps `AcceptedAggregateReadPort.readAccepted`. Unknown versions and
 * unregistered codes fail closed; owner code order is not changed.
 */
export function unwrapAcceptedAggregate(
  result: Result<AcceptedAggregateView, EvdError>
): QpAggregateReadResult {
  if (!result.ok) {
    const code = result.error.code;
    const allowed = aggregateCode(code);
    if (allowed !== null) {
      return {
        status: "rejected",
        code: allowed,
        details: { stage: "aggregate_read", upstream_code: code }
      };
    }
    return {
      status: "rejected",
      code: "E_SCHEMA",
      details: { stage: "aggregate_read", upstream_code: code }
    };
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || !aggregateShapeValid(value)) {
    return { status: "rejected", code: "E_SCHEMA", details: { stage: "aggregate_read" } };
  }
  if (value.schema_version !== "rsi.answer_aggregate/1" && value.schema_version !== "rsi.answer_aggregate/2") {
    return { status: "rejected", code: "E_SCHEMA", details: { stage: "aggregate_read" } };
  }
  return { status: "ok", aggregate: value };
}

export type QpReviewHandoffReadResult =
  | { status: "ok"; view: ReviewHandoffCloseView }
  | {
      status: "rejected";
      code: "E_HANDOFF_NOT_READY" | "E_HANDOFF_PAYLOAD_INVALID" | "E_HANDOFF_PROPOSAL_MISMATCH" | "E_SCHEMA";
      details: { stage: "review_handoff_read"; upstream_code?: string };
    };

function viewShapeValid(value: ReviewHandoffCloseView): boolean {
  return (
    typeof value.handoff_id === "string" &&
    typeof value.issue_id === "string" &&
    (value.job_state === "pending" || value.job_state === "done") &&
    Array.isArray(value.source_refs)
  );
}

/** Unwraps `ReviewHandoffReadPort.getHandoffCloseView`. */
export function unwrapReviewHandoff(
  result: Result<ReviewHandoffCloseView, ErrorEnvelope>
): QpReviewHandoffReadResult {
  if (!result.ok) {
    const code = result.error.code;
    const allowed = handoffCode(code);
    if (allowed !== null) {
      return {
        status: "rejected",
        code: allowed,
        details: { stage: "review_handoff_read", upstream_code: code }
      };
    }
    return {
      status: "rejected",
      code: "E_SCHEMA",
      details: { stage: "review_handoff_read", upstream_code: code }
    };
  }
  const value = result.value;
  if (value === null || typeof value !== "object" || !viewShapeValid(value)) {
    return { status: "rejected", code: "E_SCHEMA", details: { stage: "review_handoff_read" } };
  }
  return { status: "ok", view: value };
}
