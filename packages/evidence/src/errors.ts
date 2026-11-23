/**
 * EVD error construction (DD-EVD-024 error registry, DD-EVD-026).
 *
 * Owned codes use the `kind="registry"` detail branch. Forwarded FND/QP
 * envelopes are never re-wrapped: callers keep the owner envelope verbatim.
 * HOST `E_PROGRESS_*` codes are mapping inputs only and never become
 * `EvdError`.
 */

import { makeErrorEnvelope } from "@evoplug/core";
import type { ErrorDetails, ErrorEnvelope, JsonValue, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { EvdError, EvdForwardedErrorCode, EvdOwnedErrorCode } from "./types.js";

/**
 * The detail branch a forwarded code carries, narrowed to one `kind`.
 *
 * A forwarded envelope keeps the owner-canonical detail branch; it is never
 * re-wrapped into the registry branch.
 */
type EvdDetailsOfKind<K extends ErrorDetails["kind"]> =
  Extract<ErrorDetails, { kind: K }>;

/**
 * The owner-canonical detail branch of one forwarded code.
 *
 * The mapping is closed: a forwarded code has exactly one detail kind, and
 * the kind is the one its producing owner registers. `E_SOURCE_REF_INVALID`
 * and `E_LEDGER_ASOF_UNAVAILABLE` carry no structured detail; the codes the
 * owner registers with a field, version, idempotency or internal branch carry
 * exactly that branch.
 */
export type EvdForwardedDetailOf<C extends EvdForwardedErrorCode> =
  C extends "E_SOURCE_UNRETRIEVABLE" ? EvdDetailsOfKind<"source_unretrievable">
  : C extends "E_SOURCE_CONFLICT" ? EvdDetailsOfKind<"source_conflict">
  : C extends "E_STORAGE_BUSY" ? EvdDetailsOfKind<"storage">
  : C extends "E_SOURCE_REF_INVALID" | "E_LEDGER_ASOF_UNAVAILABLE" ? EvdDetailsOfKind<"none">
  : C extends "E_WATERMARK_AHEAD" | "E_STATE_ROW_SCHEMA" | "E_PLAN_NOT_FOUND"
      | "E_PLAN_STALE" | "E_PLAN_REQUIRED" | "E_TEMPLATE_BINDING_MISSING" ? EvdDetailsOfKind<"field">
  : C extends "E_VERSION_BINDING" | "E_PLAN_HASH_MISMATCH" | "E_SOURCE_CHANGED"
      ? EvdDetailsOfKind<"version">
  : C extends "E_IDEMPOTENCY_CONFLICT" ? EvdDetailsOfKind<"idempotency">
  : C extends "E_REBUILD_DIVERGENCE" ? EvdDetailsOfKind<"internal">
  : EvdDetailsOfKind<"source">;

/** The detail branch of any forwarded code. */
export type EvdForwardedDetails = EvdForwardedDetailOf<EvdForwardedErrorCode>;

/**
 * The detail kind every forwarded code carries, keyed by code.
 *
 * The runtime guard rejects a code whose detail branch is not the one its
 * owner registers.
 */
const FORWARDED_DETAIL_KIND: Readonly<Record<EvdForwardedErrorCode, ErrorDetails["kind"]>> = {
  E_SOURCE_HASH: "source",
  E_SOURCE_NOT_FOUND: "source",
  E_SOURCE_UTF8_INVALID: "source",
  E_SOURCE_TOO_LARGE: "source",
  E_SOURCE_OUT_OF_RANGE: "source",
  E_BLOB_MISSING: "source",
  E_STORAGE_BUSY: "storage",
  E_SOURCE_UNRETRIEVABLE: "source_unretrievable",
  E_SOURCE_CONFLICT: "source_conflict",
  E_SOURCE_REF_INVALID: "none",
  E_LEDGER_ASOF_UNAVAILABLE: "none",
  E_WATERMARK_AHEAD: "field",
  E_STATE_ROW_SCHEMA: "field",
  E_VERSION_BINDING: "version",
  E_IDEMPOTENCY_CONFLICT: "idempotency",
  E_REBUILD_DIVERGENCE: "internal",
  E_PLAN_NOT_FOUND: "field",
  E_PLAN_HASH_MISMATCH: "version",
  E_PLAN_STALE: "field",
  E_PLAN_REQUIRED: "field",
  E_TEMPLATE_BINDING_MISSING: "field",
  E_SOURCE_CHANGED: "version"
};

/** The detail kind a forwarded code carries. */
export function evdForwardedDetailKind(code: EvdForwardedErrorCode): ErrorDetails["kind"] {
  return FORWARDED_DETAIL_KIND[code];
}

/**
 * True when `details` is the detail branch its owner registers for `code`.
 *
 * A forwarded code keeps the owner-canonical branch; a registry branch is
 * rejected for every forwarded code.
 */
export function isEvdForwardedDetails(
  code: EvdForwardedErrorCode,
  details: unknown
): details is EvdForwardedDetails {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return false;
  }
  const kind = (details as { kind?: unknown }).kind;
  return kind === FORWARDED_DETAIL_KIND[code];
}

interface OwnedErrorMeta {
  category: EvdError["category"];
  retryable: boolean;
  stage: string;
  message_key: string;
  /**
   * Set only for the four external codes whose request may have crossed the
   * send point. It drives both `side_effect="unknown"` and the required
   * `details.upstream_unknown` block (DD-EVD-024).
   */
  upstream_unknown_status?: "transport_error" | "outcome_unknown";
}

/**
 * Per-code closed detail key sets (DD-EVD-024).
 *
 * `schemas/errors/fragments/evd.json` publishes `details_keys` for each of the
 * 81 `owner="evd"` rows; this table is the runtime projection of those
 * published sets. A key that is not listed for the code is rejected, and a
 * listed key that is missing is rejected too, so the runtime detail shape is
 * exactly the design's per-code closure.
 *
 * `upstream_code` is optional everywhere and `retry_after_ms` may be null, per
 * DD-EVD-024; every other listed key is required.
 */
const DETAIL_KEYS: Record<EvdOwnedErrorCode, readonly string[]> = {
  E_AGGREGATE_BINDING_INCOMPLETE: ["reason", "shard_plan_key", "shard_key"],
  E_AGGREGATE_HASH_MISMATCH: ["field", "expected", "actual"],
  E_AGGREGATE_NOT_ACCEPTED: ["aggregate_id", "final_state"],
  E_AGGREGATE_NOT_FOUND: ["aggregate_id", "scope_field"],
  E_AGGREGATE_NO_PROPOSITIONS: ["question_keys"],
  E_AGGREGATE_SNAPSHOT_MISMATCH: ["field", "expected", "actual"],
  E_ANSWER_SET: ["missing_question_keys", "extra_question_keys"],
  E_ATTEMPT_IN_FLIGHT: ["attempt_id", "lease_expires_at"],
  E_BINDING_V1_READ_ONLY: ["binding_schema_version"],
  E_BUDGET_RESERVE_INCONSISTENT: ["aggregate_output_reserve_tokens"],
  E_CHOICE_OUT_OF_SET: ["question_key", "choice"],
  E_CONFIDENCE_MISMATCH: ["question_key", "reported", "recomputed", "tolerance"],
  E_CONTENT_HASH_MISMATCH: ["content_ref", "expected", "actual"],
  E_EVD_OBJECT_TOO_LARGE: ["object_type", "observed", "limit"],
  E_EVIDENCE_CLOSURE_INCOMPLETE: ["missing_question_keys"],
  E_EVIDENCE_EXCEEDS_BUDGET: ["limiting_question_key", "observed", "limit"],
  E_EVIDENCE_INSEPARABLE_SPLIT: ["inseparable_group_key"],
  E_EVIDENCE_LIMITS_UNKNOWN: ["field"],
  E_EVIDENCE_MANIFEST_MISMATCH: ["display_id", "logical_id"],
  E_EVIDENCE_OMISSION_BINDING: ["question_keys", "impact"],
  E_EVIDENCE_PACK_STALE: ["pack_hash", "binding"],
  E_EVIDENCE_PACK_V1_READ_ONLY: ["schema_version"],
  E_EVIDENCE_PLAN_NOT_DISPATCHABLE: ["shard_plan_key", "reason"],
  E_HARD_FACT_KEY_MISMATCH: ["fact_id", "expected", "actual"],
  E_HTTP_4XX: ["http_status", "attempt_id", "upstream_unknown"],
  E_HTTP_5XX: ["http_status", "attempt_id", "upstream_unknown"],
  E_INDEX_ABORTED: [],
  E_INDEX_BINDING_INVALID: ["field", "expected", "actual"],
  E_INDEX_DEADLINE_EXCEEDED: ["deadline_ms", "stage"],
  E_INDEX_DERIVATION_FAILED: ["field", "reason"],
  E_INDEX_LIMIT_EXCEEDED: ["gate", "limit", "observed", "host_code"],
  E_INDEX_NOT_LOADED: ["method"],
  E_INDEX_PROGRESS_UNSUPPORTED: ["host_code", "missing_fields", "required_order"],
  E_INDEX_REQUEST_INVALID: ["field"],
  E_INDEX_REVIEW_SNAPSHOT_INVALID: ["review_snapshot_id"],
  E_INDEX_REVIEW_SNAPSHOT_MISSING: ["review_snapshot_id"],
  E_INDEX_SCOPE_MISMATCH: ["field", "expected", "actual"],
  E_INDEX_SNAPSHOT_ID_MISMATCH: ["expected", "actual"],
  E_INDEX_SOURCE_CONFLICT: ["source_ref", "expected", "actual", "upstream_code"],
  E_INDEX_SOURCE_HASH_MISMATCH: ["source_ref", "expected", "actual"],
  E_INDEX_SOURCE_TOO_LARGE: ["source_ref", "limit", "observed"],
  E_INDEX_SOURCE_UNRETRIEVABLE: ["source_ref", "reason"],
  E_INDEX_SOURCE_UTF8_INVALID: ["source_ref"],
  E_INDEX_UPSTREAM_UNAVAILABLE: ["upstream_code"],
  E_INDEX_VERSION_CONFLICT: ["conflict_type", "object_id"],
  E_INDEX_WATERMARK_INVALID: ["watermark", "expected"],
  E_INDEX_WINDOW_INVALID: ["from_watermark", "to_watermark", "host_code"],
  E_JUDGE_STATE_V1_READ_ONLY: ["schema_version"],
  E_MODEL_MISMATCH: ["requested_model", "returned_model"],
  E_NON_FINITE: ["question_key", "field"],
  E_OPTION_COUNT: ["question_key", "observed", "min", "max"],
  E_OUTCOME_UNKNOWN: ["attempt_id", "upstream_unknown"],
  E_PLAN_AGGREGATION_BINDING: ["question_key", "field"],
  E_PROBABILITY_KEYS: ["question_key"],
  E_PROBABILITY_RANGE: ["question_key", "field", "value"],
  E_PROBABILITY_SUM: ["question_key", "sum"],
  E_PROJECTION_OMISSION_BLOCKING: ["question_key", "omission_keys"],
  E_PROJECTION_SOURCE_MISSING: ["question_key", "source_id"],
  E_PROJECTION_VIEW_MISSING: ["question_key", "view_id"],
  E_RATE_LIMITED: ["http_status", "retry_after_ms", "attempt_id", "upstream_unknown"],
  E_SCORE_LEVELS: ["question_key"],
  E_SEMANTIC_BACKEND_UNKNOWN: ["backend_key", "reason"],
  E_SEMANTIC_CONTRACT_UNSUPPORTED: ["backend_key", "contract", "field"],
  E_SEMANTIC_OUTPUT_INVALID: ["backend_key", "offending_question_key", "field", "reason"],
  E_SEMANTIC_SCOPE_UNSUPPORTED: ["backend_key", "dimension", "observed", "supported"],
  E_SERVICE_PROFILE_BLOCKED: ["profile_key", "profile_version"],
  E_SERVICE_PROFILE_MISMATCH: ["field", "expected", "actual"],
  E_SERVICE_PROFILE_UNKNOWN: ["profile_key"],
  E_SERVICE_STATE_INCONSISTENT: ["profile_key", "expected_previous_version", "current_version"],
  E_SERVICE_UNAVAILABLE: ["upstream_code"],
  E_STATE_LOCAL_URI: ["field"],
  E_STATE_VERSION_UNSUPPORTED: ["schema_version"],
  E_STATE_VOLATILE_FIELD: ["field"],
  E_STATE_WHOLE_TASK_SCOPE: ["question_key", "scope"],
  E_TYPE: ["question_key", "expected", "actual"],
  E_UNKNOWN_OPTION: ["question_key", "option"],
  E_UNSUPPORTED_QUESTION_TYPE: ["question_key", "type"],
  E_USAGE_ESTIMATE_UNDERFLOW: ["question_key", "estimate", "observed"],
  E_VALIDATOR_BINDING_MISSING: ["validator_binding_key"],
  E_VALIDATOR_POLICY_MISMATCH: ["expected", "actual"],
  E_WIRE_INVALID: ["field"],
};

/** Keys the design allows to be omitted or null. */
const OPTIONAL_DETAIL_KEYS: ReadonlySet<string> = new Set(["upstream_code", "retry_after_ms"]);

/**
 * Returns the detail keys that are required for `code`: the published closure
 * minus the keys the design marks optional.
 */
function evdRequiredDetailKeys(code: EvdOwnedErrorCode): readonly string[] {
  return DETAIL_KEYS[code].filter((key) => !OPTIONAL_DETAIL_KEYS.has(key));
}

const OWNED_META: Record<EvdOwnedErrorCode, OwnedErrorMeta> = {
  E_INDEX_REQUEST_INVALID: {
    category: "schema",
    retryable: false,
    stage: "loader_validate",
    message_key: "error.index.request_invalid",
  },
  E_INDEX_BINDING_INVALID: {
    category: "version",
    retryable: false,
    stage: "loader_validate",
    message_key: "error.index.binding_invalid",
  },
  E_INDEX_WATERMARK_INVALID: {
    category: "usage",
    retryable: false,
    stage: "loader_validate",
    message_key: "error.index.watermark_invalid",
  },
  E_INDEX_WINDOW_INVALID: {
    category: "usage",
    retryable: false,
    stage: "loader_progress_read",
    message_key: "error.index.window_invalid",
  },
  E_INDEX_REVIEW_SNAPSHOT_INVALID: {
    category: "schema",
    retryable: false,
    stage: "loader_validate",
    message_key: "error.index.review_snapshot_invalid",
  },
  E_INDEX_REVIEW_SNAPSHOT_MISSING: {
    category: "not_found",
    retryable: false,
    stage: "loader_port_guard",
    message_key: "error.index.review_snapshot_missing",
  },
  E_INDEX_UPSTREAM_UNAVAILABLE: {
    category: "external",
    retryable: true,
    stage: "loader_upstream",
    message_key: "error.index.upstream_unavailable",
  },
  E_INDEX_PROGRESS_UNSUPPORTED: {
    category: "source",
    retryable: false,
    stage: "loader_progress_read",
    message_key: "error.index.progress_unsupported",
  },
  E_INDEX_SOURCE_UNRETRIEVABLE: {
    category: "source",
    retryable: false,
    stage: "loader_sources_resolve",
    message_key: "error.index.source_unretrievable",
  },
  E_INDEX_SOURCE_UTF8_INVALID: {
    category: "source",
    retryable: false,
    stage: "loader_sources_validate",
    message_key: "error.index.source_utf8_invalid",
  },
  E_INDEX_SOURCE_HASH_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "loader_sources_validate",
    message_key: "error.index.source_hash_mismatch",
  },
  E_INDEX_SOURCE_CONFLICT: {
    category: "conflict",
    retryable: false,
    stage: "loader_sources_validate",
    message_key: "error.index.source_conflict",
  },
  E_INDEX_SOURCE_TOO_LARGE: {
    category: "capacity",
    retryable: false,
    stage: "loader_sources_validate",
    message_key: "error.index.source_too_large",
  },
  E_INDEX_LIMIT_EXCEEDED: {
    category: "capacity",
    retryable: false,
    stage: "loader_freeze",
    message_key: "error.index.limit_exceeded",
  },
  E_INDEX_VERSION_CONFLICT: {
    category: "version",
    retryable: true,
    stage: "loader_revalidate",
    message_key: "error.index.version_conflict",
  },
  E_INDEX_DERIVATION_FAILED: {
    category: "internal",
    retryable: false,
    stage: "loader_freeze",
    message_key: "error.index.derivation_failed",
  },
  E_INDEX_ABORTED: {
    category: "deadline",
    retryable: false,
    stage: "loader_abort",
    message_key: "error.index.aborted",
  },
  E_INDEX_SCOPE_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "loader_port_guard",
    message_key: "error.index.scope_mismatch",
  },
  E_INDEX_SNAPSHOT_ID_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "loader_port_guard",
    message_key: "error.index.snapshot_id_mismatch",
  },
  E_INDEX_NOT_LOADED: {
    category: "not_found",
    retryable: false,
    stage: "loader_port_guard",
    message_key: "error.index.not_loaded",
  },
  E_INDEX_DEADLINE_EXCEEDED: {
    category: "deadline",
    retryable: true,
    stage: "loader_abort",
    message_key: "error.index.deadline_exceeded",
  },
  E_EVIDENCE_PACK_V1_READ_ONLY: {
    category: "version",
    retryable: false,
    stage: "compile",
    message_key: "error.evidence.pack_v1_read_only",
  },
  E_BINDING_V1_READ_ONLY: {
    category: "version",
    retryable: false,
    stage: "compile",
    message_key: "error.evidence.binding_v1_read_only",
  },
  E_EVIDENCE_PACK_STALE: {
    category: "version",
    retryable: false,
    stage: "compile",
    message_key: "error.evidence.pack_stale",
  },
  E_EVIDENCE_CLOSURE_INCOMPLETE: {
    category: "usage",
    retryable: false,
    stage: "closure",
    message_key: "error.evidence.closure_incomplete",
  },
  E_EVIDENCE_INSEPARABLE_SPLIT: {
    category: "conflict",
    retryable: false,
    stage: "closure",
    message_key: "error.evidence.inseparable_split",
  },
  E_EVIDENCE_EXCEEDS_BUDGET: {
    category: "budget",
    retryable: false,
    stage: "budget",
    message_key: "error.evidence.exceeds_budget",
  },
  E_EVIDENCE_OMISSION_BINDING: {
    category: "usage",
    retryable: false,
    stage: "plan_write",
    message_key: "error.evidence.omission_binding",
  },
  E_EVIDENCE_LIMITS_UNKNOWN: {
    category: "budget",
    retryable: false,
    stage: "budget",
    message_key: "error.evidence.limits_unknown",
  },
  E_EVIDENCE_PLAN_NOT_DISPATCHABLE: {
    category: "capacity",
    retryable: false,
    stage: "plan_write",
    message_key: "error.evidence.plan_not_dispatchable",
  },
  E_EVIDENCE_MANIFEST_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "binding",
    message_key: "error.evidence.manifest_mismatch",
  },
  E_BUDGET_RESERVE_INCONSISTENT: {
    category: "budget",
    retryable: false,
    stage: "budget",
    message_key: "error.budget.reserve_inconsistent",
  },
  E_PROJECTION_VIEW_MISSING: {
    category: "usage",
    retryable: false,
    stage: "projection",
    message_key: "error.projection.view_missing",
  },
  E_PROJECTION_SOURCE_MISSING: {
    category: "source",
    retryable: false,
    stage: "projection",
    message_key: "error.projection.source_missing",
  },
  E_PROJECTION_OMISSION_BLOCKING: {
    category: "policy",
    retryable: false,
    stage: "projection",
    message_key: "error.projection.omission_blocking",
  },
  E_STATE_LOCAL_URI: {
    category: "schema",
    retryable: false,
    stage: "projection",
    message_key: "error.state.local_uri",
  },
  E_STATE_VOLATILE_FIELD: {
    category: "schema",
    retryable: false,
    stage: "projection",
    message_key: "error.state.volatile_field",
  },
  E_STATE_WHOLE_TASK_SCOPE: {
    category: "policy",
    retryable: false,
    stage: "projection",
    message_key: "error.state.whole_task_scope",
  },
  E_STATE_VERSION_UNSUPPORTED: {
    category: "version",
    retryable: false,
    stage: "projection",
    message_key: "error.state.version_unsupported",
  },
  E_JUDGE_STATE_V1_READ_ONLY: {
    category: "version",
    retryable: false,
    stage: "projection",
    message_key: "error.state.v1_read_only",
  },
  E_WIRE_INVALID: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.wire.invalid",
  },
  E_ANSWER_SET: {
    category: "usage",
    retryable: false,
    stage: "response_validate",
    message_key: "error.answer_set",
  },
  E_TYPE: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.answer_type",
  },
  E_NON_FINITE: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.non_finite",
  },
  E_PROBABILITY_KEYS: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.probability_keys",
  },
  E_PROBABILITY_RANGE: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.probability_range",
  },
  E_PROBABILITY_SUM: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.probability_sum",
  },
  E_CHOICE_OUT_OF_SET: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.choice_out_of_set",
  },
  E_UNKNOWN_OPTION: {
    category: "schema",
    retryable: false,
    stage: "binding",
    message_key: "error.unknown_option",
  },
  E_OPTION_COUNT: {
    category: "schema",
    retryable: false,
    stage: "binding",
    message_key: "error.option_count",
  },
  E_SCORE_LEVELS: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.score_levels",
  },
  E_CONFIDENCE_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "response_validate",
    message_key: "error.confidence_mismatch",
  },
  E_MODEL_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "response_validate",
    message_key: "error.model_mismatch",
  },
  E_UNSUPPORTED_QUESTION_TYPE: {
    category: "usage",
    retryable: false,
    stage: "binding",
    message_key: "error.unsupported_question_type",
  },
  E_SERVICE_PROFILE_UNKNOWN: {
    category: "authorization",
    retryable: false,
    stage: "dispatch",
    message_key: "error.service_profile.unknown",
  },
  E_SERVICE_PROFILE_BLOCKED: {
    category: "authorization",
    retryable: false,
    stage: "dispatch",
    message_key: "error.service_profile.blocked",
  },
  E_SERVICE_PROFILE_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "dispatch",
    message_key: "error.service_profile.mismatch",
  },
  E_SEMANTIC_BACKEND_UNKNOWN: {
    category: "not_found",
    retryable: false,
    stage: "backend_resolve",
    message_key: "error.semantic.backend_unknown",
  },
  E_SEMANTIC_SCOPE_UNSUPPORTED: {
    category: "usage",
    retryable: false,
    stage: "scope_check",
    message_key: "error.semantic.scope_unsupported",
  },
  E_SEMANTIC_CONTRACT_UNSUPPORTED: {
    category: "version",
    retryable: false,
    stage: "contract_check",
    message_key: "error.semantic.contract_unsupported",
  },
  E_SEMANTIC_OUTPUT_INVALID: {
    category: "schema",
    retryable: false,
    stage: "response_validate",
    message_key: "error.semantic.output_invalid",
  },
  E_SERVICE_UNAVAILABLE: {
    category: "external",
    retryable: true,
    stage: "dispatch",
    message_key: "error.service.unavailable",
  },
  E_RATE_LIMITED: {
    category: "external",
    retryable: true,
    stage: "dispatch",
    message_key: "error.rate_limited",
    upstream_unknown_status: "transport_error",
  },
  E_HTTP_5XX: {
    category: "external",
    retryable: true,
    stage: "dispatch",
    message_key: "error.http.5xx",
    upstream_unknown_status: "transport_error",
  },
  E_HTTP_4XX: {
    category: "external",
    retryable: false,
    stage: "dispatch",
    message_key: "error.http.4xx",
    upstream_unknown_status: "transport_error",
  },
  E_OUTCOME_UNKNOWN: {
    category: "external",
    retryable: false,
    stage: "dispatch",
    message_key: "error.outcome_unknown",
    upstream_unknown_status: "outcome_unknown",
  },
  E_USAGE_ESTIMATE_UNDERFLOW: {
    category: "budget",
    retryable: false,
    stage: "response_validate",
    message_key: "error.usage_estimate_underflow",
  },
  E_ATTEMPT_IN_FLIGHT: {
    category: "conflict",
    retryable: false,
    stage: "dispatch",
    message_key: "error.attempt_in_flight",
  },
  E_AGGREGATE_BINDING_INCOMPLETE: {
    category: "version",
    retryable: false,
    stage: "aggregate_snapshot_read",
    message_key: "error.aggregate.binding_incomplete",
  },
  E_AGGREGATE_SNAPSHOT_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "aggregate_reduce",
    message_key: "error.aggregate.snapshot_mismatch",
  },
  E_AGGREGATE_NO_PROPOSITIONS: {
    category: "usage",
    retryable: false,
    stage: "aggregate_reduce",
    message_key: "error.aggregate.no_propositions",
  },
  E_HARD_FACT_KEY_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "aggregate_reduce",
    message_key: "error.aggregate.hard_fact_key_mismatch",
  },
  E_PLAN_AGGREGATION_BINDING: {
    category: "usage",
    retryable: false,
    stage: "aggregate_plan_read",
    message_key: "error.aggregate.plan_binding",
  },
  E_AGGREGATE_NOT_FOUND: {
    category: "not_found",
    retryable: false,
    stage: "aggregate_read",
    message_key: "error.aggregate.not_found",
  },
  E_AGGREGATE_NOT_ACCEPTED: {
    category: "policy",
    retryable: false,
    stage: "aggregate_read",
    message_key: "error.aggregate.not_accepted",
  },
  E_AGGREGATE_HASH_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "aggregate_read",
    message_key: "error.aggregate.hash_mismatch",
  },
  E_EVD_OBJECT_TOO_LARGE: {
    category: "source",
    retryable: false,
    stage: "persist",
    message_key: "error.evd.object_too_large",
  },
  E_CONTENT_HASH_MISMATCH: {
    category: "conflict",
    retryable: false,
    stage: "readback",
    message_key: "error.evd.content_hash_mismatch",
  },
  E_VALIDATOR_BINDING_MISSING: {
    category: "authorization",
    retryable: false,
    stage: "binding",
    message_key: "error.validator.binding_missing",
  },
  E_VALIDATOR_POLICY_MISMATCH: {
    category: "version",
    retryable: false,
    stage: "aggregate_read",
    message_key: "error.validator.policy_mismatch",
  },
  E_SERVICE_STATE_INCONSISTENT: {
    category: "conflict",
    retryable: false,
    stage: "persist",
    message_key: "error.service.state_inconsistent",
  },
};

interface UpstreamUnknownDetail {
  request_dispatched: boolean;
  attempt_status: "transport_error" | "outcome_unknown";
  retryable: boolean;
  upstream_code?: string;
}

function isUpstreamUnknownDetail(value: unknown): value is UpstreamUnknownDetail {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["request_dispatched"] === "boolean" &&
    (record["attempt_status"] === "transport_error" ||
      record["attempt_status"] === "outcome_unknown") &&
    typeof record["retryable"] === "boolean" &&
    (record["upstream_code"] === undefined || typeof record["upstream_code"] === "string")
  );
}

/**
 * Registry details projection for owned codes.
 *
 * The four external codes always carry `upstream_unknown`: the request may
 * have crossed the send point even when no response was observed. Callers can
 * supply the observed attempt state; otherwise the registry default is used.
 */
function registryDetailValue(
  details: Record<string, unknown>,
  meta: OwnedErrorMeta
): JsonValue {
  if (meta.upstream_unknown_status === undefined) {
    return details as JsonValue;
  }
  const supplied = details["upstream_unknown"];
  let upstreamUnknown: Record<string, JsonValue>;
  if (isUpstreamUnknownDetail(supplied)) {
    upstreamUnknown = {
      request_dispatched: supplied.request_dispatched,
      attempt_status: supplied.attempt_status,
      retryable: supplied.retryable,
    };
    if (supplied.upstream_code !== undefined) {
      upstreamUnknown["upstream_code"] = supplied.upstream_code;
    }
  } else {
    upstreamUnknown = {
      request_dispatched: true,
      attempt_status: meta.upstream_unknown_status,
      retryable: meta.retryable,
    };
  }
  const base = details as Record<string, JsonValue>;
  return { ...base, upstream_unknown: upstreamUnknown };
}

/**
 * The `owner="evd"` codes of DD-EVD-024, in the published order.
 *
 * `RegistryDetailCode` is exactly these 81 codes; the 31 cross-domain rows of
 * the forwarding matrix are not part of it.
 */
export const EVD_REGISTRY_DETAIL_CODES: readonly EvdOwnedErrorCode[] = Object.freeze([
    "E_AGGREGATE_BINDING_INCOMPLETE",
    "E_AGGREGATE_HASH_MISMATCH",
    "E_AGGREGATE_NOT_ACCEPTED",
    "E_AGGREGATE_NOT_FOUND",
    "E_AGGREGATE_NO_PROPOSITIONS",
    "E_AGGREGATE_SNAPSHOT_MISMATCH",
    "E_ANSWER_SET",
    "E_ATTEMPT_IN_FLIGHT",
    "E_BINDING_V1_READ_ONLY",
    "E_BUDGET_RESERVE_INCONSISTENT",
    "E_CHOICE_OUT_OF_SET",
    "E_CONFIDENCE_MISMATCH",
    "E_CONTENT_HASH_MISMATCH",
    "E_EVD_OBJECT_TOO_LARGE",
    "E_EVIDENCE_CLOSURE_INCOMPLETE",
    "E_EVIDENCE_EXCEEDS_BUDGET",
    "E_EVIDENCE_INSEPARABLE_SPLIT",
    "E_EVIDENCE_LIMITS_UNKNOWN",
    "E_EVIDENCE_MANIFEST_MISMATCH",
    "E_EVIDENCE_OMISSION_BINDING",
    "E_EVIDENCE_PACK_STALE",
    "E_EVIDENCE_PACK_V1_READ_ONLY",
    "E_EVIDENCE_PLAN_NOT_DISPATCHABLE",
    "E_HARD_FACT_KEY_MISMATCH",
    "E_HTTP_4XX",
    "E_HTTP_5XX",
    "E_INDEX_ABORTED",
    "E_INDEX_BINDING_INVALID",
    "E_INDEX_DEADLINE_EXCEEDED",
    "E_INDEX_DERIVATION_FAILED",
    "E_INDEX_LIMIT_EXCEEDED",
    "E_INDEX_NOT_LOADED",
    "E_INDEX_PROGRESS_UNSUPPORTED",
    "E_INDEX_REQUEST_INVALID",
    "E_INDEX_REVIEW_SNAPSHOT_INVALID",
    "E_INDEX_REVIEW_SNAPSHOT_MISSING",
    "E_INDEX_SCOPE_MISMATCH",
    "E_INDEX_SNAPSHOT_ID_MISMATCH",
    "E_INDEX_SOURCE_CONFLICT",
    "E_INDEX_SOURCE_HASH_MISMATCH",
    "E_INDEX_SOURCE_TOO_LARGE",
    "E_INDEX_SOURCE_UNRETRIEVABLE",
    "E_INDEX_SOURCE_UTF8_INVALID",
    "E_INDEX_UPSTREAM_UNAVAILABLE",
    "E_INDEX_VERSION_CONFLICT",
    "E_INDEX_WATERMARK_INVALID",
    "E_INDEX_WINDOW_INVALID",
    "E_JUDGE_STATE_V1_READ_ONLY",
    "E_MODEL_MISMATCH",
    "E_NON_FINITE",
    "E_OPTION_COUNT",
    "E_OUTCOME_UNKNOWN",
    "E_PLAN_AGGREGATION_BINDING",
    "E_PROBABILITY_KEYS",
    "E_PROBABILITY_RANGE",
    "E_PROBABILITY_SUM",
    "E_PROJECTION_OMISSION_BLOCKING",
    "E_PROJECTION_SOURCE_MISSING",
    "E_PROJECTION_VIEW_MISSING",
    "E_RATE_LIMITED",
    "E_SCORE_LEVELS",
    "E_SEMANTIC_BACKEND_UNKNOWN",
    "E_SEMANTIC_CONTRACT_UNSUPPORTED",
    "E_SEMANTIC_OUTPUT_INVALID",
    "E_SEMANTIC_SCOPE_UNSUPPORTED",
    "E_SERVICE_PROFILE_BLOCKED",
    "E_SERVICE_PROFILE_MISMATCH",
    "E_SERVICE_PROFILE_UNKNOWN",
    "E_SERVICE_STATE_INCONSISTENT",
    "E_SERVICE_UNAVAILABLE",
    "E_STATE_LOCAL_URI",
    "E_STATE_VERSION_UNSUPPORTED",
    "E_STATE_VOLATILE_FIELD",
    "E_STATE_WHOLE_TASK_SCOPE",
    "E_TYPE",
    "E_UNKNOWN_OPTION",
    "E_UNSUPPORTED_QUESTION_TYPE",
    "E_USAGE_ESTIMATE_UNDERFLOW",
    "E_VALIDATOR_BINDING_MISSING",
    "E_VALIDATOR_POLICY_MISMATCH",
    "E_WIRE_INVALID"
]);

/** One published registry row: the 13 registry fields plus the detail closure. */
interface EvdRegistryRow {
  readonly code: string;
  readonly owner: string;
  readonly category: string;
  readonly retryable_default: boolean;
  readonly side_effect_allowed: boolean;
  readonly replacement: string | null;
  readonly since: string;
  readonly deprecated: boolean;
  readonly details_kind: string;
  readonly details_schema: string;
  readonly stage: string;
  readonly aliases: readonly string[];
  readonly source: string;
  /** The per-code detail key closure (DD-EVD-024). */
  readonly details_keys: readonly string[];
}

/**
 * Builds the registry from published owner fragments.
 *
 * The fragments are the only source; this builder never invents a row, never
 * repairs a missing code and never lets one owner publish another's code. A
 * duplicate code, a wrong owner, a missing detail closure or a `registry`
 * details kind outside EVD is a build failure.
 */
export function buildErrorRegistry(
  fragments: Readonly<Record<string, readonly {
    code: string;
    owner: string;
    category: string;
    retryable_default: boolean;
    side_effect_allowed: boolean;
    replacement: string | null;
    since: string;
    deprecated: boolean;
    details_kind: string;
    details_schema: string;
    stage: string;
    aliases?: readonly string[];
    source: string;
    details_keys?: readonly string[];
  }[]>>
): {
  readonly rows: readonly EvdRegistryRow[];
  readonly errors: readonly string[];
} {
  const rows: EvdRegistryRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [owner, entries] of Object.entries(fragments)) {
    for (const entry of entries) {
      if (entry.owner !== owner) {
        errors.push(`${entry.code}: owner "${entry.owner}" does not match fragment owner "${owner}"`);
        continue;
      }
      if (seen.has(entry.code)) {
        errors.push(`${entry.code}: duplicate registry row`);
        continue;
      }
      seen.add(entry.code);
      if (entry.details_kind === "registry" && owner !== "evd") {
        errors.push(`${entry.code}: details kind "registry" is owned by evd only`);
        continue;
      }
      if (owner === "evd" && !Array.isArray(entry.details_keys)) {
        errors.push(`${entry.code}: evd row must publish its detail key closure`);
        continue;
      }
      rows.push({
        ...entry,
        aliases: entry.aliases ?? [],
        details_keys: entry.details_keys ?? []
      });
    }
  }
  return { rows, errors };
}

export function evdError(
  code: EvdOwnedErrorCode,
  details: Record<string, unknown>
): EvdError {
  const meta = OWNED_META[code];
  const sideEffect = meta.upstream_unknown_status === undefined ? "none" : "unknown";
  return makeErrorEnvelope({
    code,
    category: meta.category,
    retryable: meta.retryable,
    side_effect: sideEffect,
    message_key: meta.message_key,
    stage: meta.stage,
    details: { kind: "registry", code, details: registryDetailValue(details, meta) },
  }) as EvdError;
}

/**
 * Rejects a detail object that does not match the code's published closure.
 *
 * DD-EVD-024: a code accepts exactly the keys listed for it; a key outside the
 * closure is rejected, and a required key that is missing is rejected. The
 * check is closed in both directions.
 */
export function isEvdDetailShapeValid(
  code: EvdOwnedErrorCode,
  details: Record<string, unknown>
): boolean {
  const published = new Set(DETAIL_KEYS[code]);
  for (const key of Object.keys(details)) {
    if (!published.has(key)) {
      return false;
    }
  }
  for (const key of evdRequiredDetailKeys(code)) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) {
      return false;
    }
  }
  return true;
}

export function evdErr<T>(
  code: EvdOwnedErrorCode,
  details: Record<string, unknown>
): Result<T, EvdError> {
  return err(evdError(code, details));
}

export function evdOk<T>(value: T): Result<T, EvdError> {
  return ok(value);
}

const FORWARDED_CATEGORY: Record<EvdForwardedErrorCode, EvdError["category"]> = {
  E_SOURCE_HASH: "source",
  E_SOURCE_NOT_FOUND: "source",
  E_SOURCE_UTF8_INVALID: "source",
  E_SOURCE_TOO_LARGE: "source",
  E_SOURCE_OUT_OF_RANGE: "source",
  E_BLOB_MISSING: "storage",
  E_STORAGE_BUSY: "storage",
  E_SOURCE_UNRETRIEVABLE: "source",
  E_SOURCE_CONFLICT: "conflict",
  E_SOURCE_REF_INVALID: "source",
  E_LEDGER_ASOF_UNAVAILABLE: "version",
  E_WATERMARK_AHEAD: "version",
  E_STATE_ROW_SCHEMA: "schema",
  E_VERSION_BINDING: "version",
  E_IDEMPOTENCY_CONFLICT: "conflict",
  E_REBUILD_DIVERGENCE: "internal",
  E_PLAN_NOT_FOUND: "not_found",
  E_PLAN_HASH_MISMATCH: "conflict",
  E_PLAN_STALE: "version",
  E_PLAN_REQUIRED: "usage",
  E_TEMPLATE_BINDING_MISSING: "version",
  E_SOURCE_CHANGED: "conflict",
};

/** Owner-canonical forwarded error; details stay in the generic `none` branch. */
export function evdForwardedError(
  code: EvdForwardedErrorCode,
  details: Record<string, unknown> = {}
): EvdError {
  return makeErrorEnvelope({
    code,
    category: FORWARDED_CATEGORY[code],
    retryable: code === "E_STORAGE_BUSY",
    side_effect: "none",
    message_key: `error.forwarded.${code.toLowerCase()}`,
    stage: "forwarded",
    // Owner-canonical forwarded envelopes keep `kind="none"`. When the
    // forwarding site has structured diagnostics it records them beside the
    // kind so the caller can tell the two conflicting sources apart.
    details:
      Object.keys(details).length === 0
        ? { kind: "none" }
        : ({ kind: "none", details } as never),
  }) as EvdError;
}

export function evdForwarded<T>(
  code: EvdForwardedErrorCode,
  details: Record<string, unknown> = {}
): Result<T, EvdError> {
  return err(evdForwardedError(code, details));
}

/** Owner-canonical `E_REBUILD_DIVERGENCE` used by the replay boundary. */
export function evdRebuildDivergence(incident_id = "evd-rebuild"): EvdError {
  return makeErrorEnvelope({
    code: "E_REBUILD_DIVERGENCE",
    category: "internal",
    retryable: false,
    side_effect: "none",
    message_key: "error.rebuild_divergence",
    stage: "rebuild",
    details: { kind: "internal", incident_id },
  }) as EvdError;
}

/** Re-throws nothing: converts an owner envelope to `EvdError` verbatim. */
export function asEvdError(error: ErrorEnvelope): EvdError {
  return error as EvdError;
}

export function evdErrorMessageKey(code: EvdOwnedErrorCode): string {
  return OWNED_META[code].message_key;
}

export function evdErrorStage(code: EvdOwnedErrorCode): string {
  return OWNED_META[code].stage;
}

export function isEvdOwnedErrorCode(code: string): code is EvdOwnedErrorCode {
  return Object.prototype.hasOwnProperty.call(OWNED_META, code);
}

