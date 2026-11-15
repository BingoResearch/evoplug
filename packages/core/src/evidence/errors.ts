/**
 * QP failure codes and envelopes (DD-QP-28).
 *
 * `FailureCode` is the QP runtime union. Owner rows are frozen in
 * `schemas/domains/qp/qp.errors.json`; forwarded codes keep their production
 * owner. `E_EVIDENCE_CLOSURE_INCOMPLETE` (EVD) is deliberately absent.
 */

import { makeErrorEnvelope, type ErrorCategory, type ErrorDetails, type ErrorEnvelope } from "../errors.js";
import type { Hash } from "../hash.js";

export type QpOwnerFailureCode =
  | "E_ISSUE_VERSION_CONFLICT"
  | "E_ISSUE_TRANSITION_ILLEGAL"
  | "E_TRANSITION_ID_COLLISION"
  | "E_CONFIRMATION_KIND_NOT_ALLOWED"
  | "E_CONFIRMATION_EVIDENCE_INSUFFICIENT"
  | "E_REQUIREMENT_UNKNOWN"
  | "E_CLOSE_EVIDENCE_INSUFFICIENT"
  | "E_REOPEN_EVIDENCE_INSUFFICIENT"
  | "E_REOPEN_EVIDENCE_REUSED"
  | "E_GOAL_STALE"
  | "E_TEMPLATE_NOT_FOUND"
  | "E_TEMPLATE_DEPRECATED"
  | "E_TEMPLATE_HASH_MISMATCH"
  | "E_TEMPLATE_ISSUE_TYPE_MISMATCH"
  | "E_TEMPLATE_BINDING_MISSING"
  | "E_REQUIRED_SOURCE_MISSING"
  | "E_SOURCE_COUNT_EXCEEDED"
  | "E_SOURCE_CHANGED"
  | "E_EXCERPT_EXCEEDS_LIMIT"
  | "E_BYTE_RANGE_INVALID"
  | "E_FACT_VALUE_INVALID"
  | "E_CONTRACT_PATH_MISMATCH"
  | "E_PLAN_CLOSURE_INCOMPLETE"
  | "E_PLAN_STALE"
  | "E_PLAN_HASH_MISMATCH"
  | "E_PLAN_NOT_FOUND"
  | "E_PLAN_STATE_CONFLICT"
  | "E_PERSISTENCE_INTEGRITY"
  | "E_VIEW_PROFILE_MISMATCH"
  | "E_WHOLE_TASK_SCOPE_NOT_ALLOWED"
  | "E_JUDGMENT_BASIS_INSUFFICIENT"
  | "E_ISSUE_LIMIT"
  | "E_PLAN_REQUIRED";

export type QpForwardedFailureCode =
  | "E_SCHEMA"
  | "E_VERSION_BINDING"
  | "E_SOURCE_CONFLICT"
  | "E_SOURCE_UNRETRIEVABLE"
  | "E_SOURCE_UTF8_INVALID"
  | "E_PROJECTION_VIEW_MISSING"
  | "E_PROJECTION_SOURCE_MISSING"
  | "E_PROJECTION_OMISSION_BLOCKING"
  | "E_STATE_WHOLE_TASK_SCOPE"
  | "E_STATE_VOLATILE_FIELD"
  | "E_JUDGE_STATE_V1_READ_ONLY"
  | "E_STATE_VERSION_UNSUPPORTED"
  | "E_AGGREGATE_NOT_FOUND"
  | "E_AGGREGATE_NOT_ACCEPTED"
  | "E_AGGREGATE_HASH_MISMATCH"
  | "E_EVIDENCE_INSEPARABLE_SPLIT"
  | "E_PLAN_AGGREGATION_BINDING"
  | "E_HANDOFF_NOT_READY"
  | "E_HANDOFF_PAYLOAD_INVALID"
  | "E_HANDOFF_PROPOSAL_MISMATCH";

/** EVD index/loading codes forwarded unchanged by QP. */
export type EvdIndexErrorCode =
  | "E_INDEX_NOT_LOADED"
  | "E_INDEX_REQUEST_INVALID"
  | "E_INDEX_SCOPE_MISMATCH"
  | "E_INDEX_WINDOW_INVALID"
  | "E_INDEX_BINDING_INVALID"
  | "E_INDEX_WATERMARK_INVALID"
  | "E_INDEX_PROGRESS_UNSUPPORTED"
  | "E_INDEX_REVIEW_SNAPSHOT_MISSING"
  | "E_INDEX_REVIEW_SNAPSHOT_INVALID"
  | "E_INDEX_SOURCE_UNRETRIEVABLE"
  | "E_INDEX_SOURCE_UTF8_INVALID"
  | "E_INDEX_SOURCE_HASH_MISMATCH"
  | "E_INDEX_SOURCE_CONFLICT"
  | "E_INDEX_LIMIT_EXCEEDED"
  | "E_INDEX_UPSTREAM_UNAVAILABLE"
  | "E_INDEX_VERSION_CONFLICT"
  | "E_INDEX_DEADLINE_EXCEEDED"
  | "E_INDEX_ABORTED"
  | "E_INDEX_SOURCE_TOO_LARGE";

export type FailureCode = QpOwnerFailureCode | QpForwardedFailureCode | EvdIndexErrorCode;

/** Error registry row shape for the 13 fields frozen in `qp.errors.json`. */
export interface QpErrorRegistryRow {
  code: QpOwnerFailureCode;
  owner: "qp";
  category: ErrorCategory;
  retryable_default: boolean;
  side_effect_allowed: "none" | "partial" | "unknown";
  replacement: string | null;
  since: string;
  deprecated: boolean;
  details_kind: string;
  details_schema: string | null;
  stage: string;
  aliases: string[];
  source: string;
}

const OWNER_ROWS: ReadonlyArray<QpErrorRegistryRow> = [
  {
    code: "E_ISSUE_VERSION_CONFLICT",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "issue_transition",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_ISSUE_TRANSITION_ILLEGAL",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "issue_transition",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TRANSITION_ID_COLLISION",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "idempotency",
    details_schema: "urn:evoplug:schema:error-details:idempotency:1",
    stage: "issue_transition",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_CONFIRMATION_KIND_NOT_ALLOWED",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "confirmation",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_CONFIRMATION_EVIDENCE_INSUFFICIENT",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "none",
    details_schema: "urn:evoplug:schema:error-details:none:1",
    stage: "confirmation",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_REQUIREMENT_UNKNOWN",
    owner: "qp",
    category: "not_found",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "confirmation",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_CLOSE_EVIDENCE_INSUFFICIENT",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "none",
    details_schema: "urn:evoplug:schema:error-details:none:1",
    stage: "close_evidence",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_REOPEN_EVIDENCE_INSUFFICIENT",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "none",
    details_schema: "urn:evoplug:schema:error-details:none:1",
    stage: "reopen_evidence",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_REOPEN_EVIDENCE_REUSED",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "reopen_evidence",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_GOAL_STALE",
    owner: "qp",
    category: "version",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "goal_binding",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TEMPLATE_NOT_FOUND",
    owner: "qp",
    category: "not_found",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "template_load",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TEMPLATE_DEPRECATED",
    owner: "qp",
    category: "version",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "template_load",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TEMPLATE_HASH_MISMATCH",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "template_load",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TEMPLATE_ISSUE_TYPE_MISMATCH",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "template_bind",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_TEMPLATE_BINDING_MISSING",
    owner: "qp",
    category: "version",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "binding",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_REQUIRED_SOURCE_MISSING",
    owner: "qp",
    category: "source",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "source",
    details_schema: "urn:evoplug:schema:error-details:source:1",
    stage: "plan_source",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_SOURCE_COUNT_EXCEEDED",
    owner: "qp",
    category: "source",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "plan_source",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_SOURCE_CHANGED",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "binding",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_EXCERPT_EXCEEDS_LIMIT",
    owner: "qp",
    category: "source",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "source",
    details_schema: "urn:evoplug:schema:error-details:source:1",
    stage: "source_excerpt",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_BYTE_RANGE_INVALID",
    owner: "qp",
    category: "source",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "source",
    details_schema: "urn:evoplug:schema:error-details:source:1",
    stage: "source_excerpt",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_FACT_VALUE_INVALID",
    owner: "qp",
    category: "schema",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "plan_source",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_CONTRACT_PATH_MISMATCH",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "plan_source",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_CLOSURE_INCOMPLETE",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "none",
    details_schema: "urn:evoplug:schema:error-details:none:1",
    stage: "plan_build",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_STALE",
    owner: "qp",
    category: "version",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "aggregate_plan_read",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_HASH_MISMATCH",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "aggregate_plan_read",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_NOT_FOUND",
    owner: "qp",
    category: "not_found",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "aggregate_plan_read",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_STATE_CONFLICT",
    owner: "qp",
    category: "conflict",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "version",
    details_schema: "urn:evoplug:schema:error-details:version:1",
    stage: "plan_state",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PERSISTENCE_INTEGRITY",
    owner: "qp",
    category: "internal",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "storage",
    details_schema: "urn:evoplug:schema:error-details:storage:1",
    stage: "persist",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_VIEW_PROFILE_MISMATCH",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "projection_validate",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_WHOLE_TASK_SCOPE_NOT_ALLOWED",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "plan_input",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_JUDGMENT_BASIS_INSUFFICIENT",
    owner: "qp",
    category: "policy",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "none",
    details_schema: "urn:evoplug:schema:error-details:none:1",
    stage: "judgment_map",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_ISSUE_LIMIT",
    owner: "qp",
    category: "capacity",
    retryable_default: false,
    side_effect_allowed: "partial",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "issue_discovery",
    aliases: [],
    source: "DD-QP-28"
  },
  {
    code: "E_PLAN_REQUIRED",
    owner: "qp",
    category: "usage",
    retryable_default: false,
    side_effect_allowed: "none",
    replacement: null,
    since: "2026-10-20",
    deprecated: false,
    details_kind: "field",
    details_schema: "urn:evoplug:schema:error-details:field:1",
    stage: "binding",
    aliases: [],
    source: "DD-QP-28"
  }
];

/** The 33 frozen QP owner rows, in registry order. */
export const QP_ERROR_REGISTRY: readonly QpErrorRegistryRow[] = Object.freeze(OWNER_ROWS);

/** Every QP runtime failure code (owner plus forwarded). */
export const QP_FAILURE_CODES: readonly FailureCode[] = Object.freeze([
  ...OWNER_ROWS.map((row) => row.code),
  "E_SCHEMA",
  "E_VERSION_BINDING",
  "E_SOURCE_CONFLICT",
  "E_SOURCE_UNRETRIEVABLE",
  "E_SOURCE_UTF8_INVALID",
  "E_PROJECTION_VIEW_MISSING",
  "E_PROJECTION_SOURCE_MISSING",
  "E_PROJECTION_OMISSION_BLOCKING",
  "E_STATE_WHOLE_TASK_SCOPE",
  "E_STATE_VOLATILE_FIELD",
  "E_JUDGE_STATE_V1_READ_ONLY",
  "E_STATE_VERSION_UNSUPPORTED",
  "E_AGGREGATE_NOT_FOUND",
  "E_AGGREGATE_NOT_ACCEPTED",
  "E_AGGREGATE_HASH_MISMATCH",
  "E_EVIDENCE_INSEPARABLE_SPLIT",
  "E_PLAN_AGGREGATION_BINDING",
  "E_HANDOFF_NOT_READY",
  "E_HANDOFF_PAYLOAD_INVALID",
  "E_HANDOFF_PROPOSAL_MISMATCH"
]);

const CATEGORY_BY_CODE: Readonly<Record<string, ErrorCategory>> = Object.freeze({
  E_ISSUE_VERSION_CONFLICT: "conflict",
  E_ISSUE_TRANSITION_ILLEGAL: "usage",
  E_TRANSITION_ID_COLLISION: "conflict",
  E_CONFIRMATION_KIND_NOT_ALLOWED: "usage",
  E_CONFIRMATION_EVIDENCE_INSUFFICIENT: "policy",
  E_REQUIREMENT_UNKNOWN: "not_found",
  E_CLOSE_EVIDENCE_INSUFFICIENT: "policy",
  E_REOPEN_EVIDENCE_INSUFFICIENT: "policy",
  E_REOPEN_EVIDENCE_REUSED: "policy",
  E_GOAL_STALE: "version",
  E_TEMPLATE_NOT_FOUND: "not_found",
  E_TEMPLATE_DEPRECATED: "version",
  E_TEMPLATE_HASH_MISMATCH: "conflict",
  E_TEMPLATE_ISSUE_TYPE_MISMATCH: "schema",
  E_TEMPLATE_BINDING_MISSING: "policy",
  E_REQUIRED_SOURCE_MISSING: "policy",
  E_SOURCE_COUNT_EXCEEDED: "capacity",
  E_SOURCE_CHANGED: "source",
  E_EXCERPT_EXCEEDS_LIMIT: "capacity",
  E_BYTE_RANGE_INVALID: "source",
  E_FACT_VALUE_INVALID: "schema",
  E_CONTRACT_PATH_MISMATCH: "source",
  E_PLAN_CLOSURE_INCOMPLETE: "policy",
  E_PLAN_STALE: "version",
  E_PLAN_HASH_MISMATCH: "conflict",
  E_PLAN_NOT_FOUND: "not_found",
  E_PLAN_STATE_CONFLICT: "conflict",
  E_PERSISTENCE_INTEGRITY: "storage",
  E_VIEW_PROFILE_MISMATCH: "policy",
  E_WHOLE_TASK_SCOPE_NOT_ALLOWED: "policy",
  E_JUDGMENT_BASIS_INSUFFICIENT: "policy",
  E_ISSUE_LIMIT: "capacity",
  E_PLAN_REQUIRED: "policy",
  E_SCHEMA: "schema",
  E_VERSION_BINDING: "version",
  E_SOURCE_CONFLICT: "source",
  E_SOURCE_UNRETRIEVABLE: "source",
  E_SOURCE_UTF8_INVALID: "source",
  E_PROJECTION_VIEW_MISSING: "policy",
  E_PROJECTION_SOURCE_MISSING: "policy",
  E_PROJECTION_OMISSION_BLOCKING: "policy",
  E_STATE_WHOLE_TASK_SCOPE: "policy",
  E_STATE_VOLATILE_FIELD: "schema",
  E_JUDGE_STATE_V1_READ_ONLY: "usage",
  E_STATE_VERSION_UNSUPPORTED: "version",
  E_AGGREGATE_NOT_FOUND: "not_found",
  E_AGGREGATE_NOT_ACCEPTED: "policy",
  E_AGGREGATE_HASH_MISMATCH: "conflict",
  E_EVIDENCE_INSEPARABLE_SPLIT: "policy",
  E_PLAN_AGGREGATION_BINDING: "schema",
  E_HANDOFF_NOT_READY: "policy",
  E_HANDOFF_PAYLOAD_INVALID: "schema",
  E_HANDOFF_PROPOSAL_MISMATCH: "conflict"
});

function categoryFor(code: string): ErrorCategory {
  const category = CATEGORY_BY_CODE[code];
  if (category !== undefined) {
    return category;
  }
  return code.startsWith("E_INDEX_") ? "external" : "internal";
}

function stageFor(code: string): string {
  return code.startsWith("E_INDEX_") ? "index" : "qp";
}

/** Message key convention: `error.<snake_case_code>`. */
export function messageKeyFor(code: string): string {
  return `error.${code.slice(2).toLowerCase()}`;
}

/**
 * Builds a QP failure envelope. `stage` is the concrete path stage from the
 * design (for example `judgment_route_schema`); it replaces the registry
 * default without changing the code or details branch.
 *
 * DD-FND-103 reserves the `registry` detail branch for `owner="evd"`; a QP
 * owner row uses the branch its `details_kind` names (DD-QP-28). The
 * diagnostic payload the call site supplies is folded into that branch: the
 * `field` branch takes `path`/`rule`, the `version` branch takes
 * `expected`/`actual`, the `source` branch takes `source_ref`/`reason`, the
 * `idempotency` branch takes `key`/`existing_hash`/`incoming_hash` and the
 * `storage` branch takes `operation`. A code whose branch has no room for the
 * payload keeps the `none` branch and carries the payload in the message key
 * free stage, so no free-text field is invented.
 */
export function qpFailure(code: FailureCode, stage: string, details?: JsonValueLike): ErrorEnvelope {
  const payload = details ?? {};
  return makeErrorEnvelope({
    code,
    category: categoryFor(code),
    message_key: messageKeyFor(code),
    stage,
    details: detailsBranchFor(code, payload, stage)
  });
}

/** The closed detail branch of one QP owner row. */
function detailsBranchFor(code: FailureCode, payload: JsonValueLike, stage: string): ErrorDetails {
  const row = OWNER_ROWS.find((entry) => entry.code === code);
  const kind = row?.details_kind ?? forwardedDetailsKind(code);
  switch (kind) {
    case "field": {
      const path = typeof payload["path"] === "string" ? payload["path"] : stage;
      const rule = typeof payload["rule"] === "string" ? payload["rule"] : "qp_field";
      return { kind: "field", path, rule };
    }
    case "version": {
      const expected =
        typeof payload["expected"] === "string"
          ? payload["expected"]
          : typeof payload["expected_version"] === "number"
            ? String(payload["expected_version"])
            : stage;
      const actual =
        typeof payload["actual"] === "string"
          ? payload["actual"]
          : typeof payload["actual_version"] === "number"
            ? String(payload["actual_version"])
            : stage;
      return { kind: "version", expected, actual };
    }
    case "source": {
      const sourceRef = typeof payload["source_ref"] === "string" ? payload["source_ref"] : "";
      const reason = sourceReason(payload["reason"]);
      return { kind: "source", source_ref: sourceRef, reason };
    }
    case "source_unretrievable": {
      const sourceRef = typeof payload["source_ref"] === "string" ? payload["source_ref"] : "";
      const upstream =
        typeof payload["upstream_code"] === "string" ? payload["upstream_code"] : "E_SOURCE_UNRETRIEVABLE";
      return { kind: "source_unretrievable", source_ref: sourceRef, upstream_code: upstream };
    }
    case "idempotency": {
      const key = typeof payload["key"] === "string" ? payload["key"] : "";
      const existing =
        (typeof payload["existing_hash"] === "string" ? payload["existing_hash"] : EMPTY_HASH) as Hash;
      const incoming =
        (typeof payload["incoming_hash"] === "string" ? payload["incoming_hash"] : EMPTY_HASH) as Hash;
      return { kind: "idempotency", key, existing_hash: existing, incoming_hash: incoming };
    }
    case "storage": {
      const operation = typeof payload["operation"] === "string" ? payload["operation"] : stage;
      return { kind: "storage", operation };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * The detail branch of a forwarded code, taken from its producing owner's
 * canonical row (DD-FND-103). Only the codes QP forwards need one.
 */
function forwardedDetailsKind(code: FailureCode): string {
  switch (code) {
    case "E_SOURCE_UNRETRIEVABLE":
      return "source_unretrievable";
    case "E_SOURCE_CHANGED":
      return "source";
    case "E_SCHEMA":
    case "E_VERSION_BINDING":
    case "E_STATE_VOLATILE_FIELD":
    case "E_PROJECTION_VIEW_MISSING":
    case "E_PROJECTION_SOURCE_MISSING":
    case "E_PROJECTION_OMISSION_BLOCKING":
    case "E_STATE_WHOLE_TASK_SCOPE":
    case "E_JUDGE_STATE_V1_READ_ONLY":
    case "E_STATE_VERSION_UNSUPPORTED":
      return "field";
    case "E_SOURCE_CONFLICT":
      return "source_conflict";
    case "E_SOURCE_UTF8_INVALID":
      return "source";
    case "E_PLAN_AGGREGATION_BINDING":
      return "registry";
    default:
      return "none";
  }
}

const EMPTY_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function sourceReason(value: string | number | boolean | null | undefined): "missing" | "tombstoned" | "hash_mismatch" | "out_of_range" | "not_utf8" | "too_large" {
  switch (value) {
    case "tombstoned":
    case "hash_mismatch":
    case "out_of_range":
    case "not_utf8":
    case "too_large":
      return value;
    default:
      return "missing";
  }
}

/** JSON-compatible detail payload accepted by `qpFailure`. */
export type JsonValueLike = Record<string, string | number | boolean | null>;

/** Returns true when a runtime string is a QP failure code. */
export function isFailureCode(value: string): value is FailureCode {
  return (QP_FAILURE_CODES as readonly string[]).includes(value);
}

/** Narrows a runtime code, defaulting to `E_SCHEMA` when unknown. */
export function failureCode(value: string): FailureCode {
  return isFailureCode(value) ? value : "E_SCHEMA";
}

/** Returns true for the three REV handoff codes QP forwards. */
export function isHandoffCode(code: string): boolean {
  return (
    code === "E_HANDOFF_NOT_READY" ||
    code === "E_HANDOFF_PAYLOAD_INVALID" ||
    code === "E_HANDOFF_PROPOSAL_MISMATCH"
  );
}

/** Returns true for the four aggregate read codes allowed by the EVD port. */
export function isAcceptedAggregateCode(code: string): boolean {
  return (
    code === "E_AGGREGATE_NOT_FOUND" ||
    code === "E_AGGREGATE_NOT_ACCEPTED" ||
    code === "E_AGGREGATE_HASH_MISMATCH" ||
    code === "E_SOURCE_UNRETRIEVABLE"
  );
}
