/**
 * Egress error envelopes (DD-FND-093, DD-FND-093.1, DD-FND-097.6).
 *
 * Only the canonical codes registered for the egress owner are produced here.
 * Decision reason codes (`endpoint_not_allowed`, `approval_required`, …) are
 * result details, never error codes, and therefore never appear in an
 * `ErrorEnvelope`.
 */

import { makeErrorEnvelope } from "@evoplug/core";
import type {
  ErrorCategory,
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  SourceRef,
} from "@evoplug/core";

export type EgressErrorCode =
  | "E_EGRESS_REQUEST_PREIMAGE"
  | "E_EGRESS_REQUEST_INVALID"
  | "E_EGRESS_REQUEST_HASH"
  | "E_EGRESS_POLICY_STALE"
  | "E_EGRESS_BYTE_LIMIT"
  | "E_EGRESS_APPROVAL_NOT_FOUND"
  | "E_EGRESS_APPROVAL_MISMATCH"
  | "E_EGRESS_APPROVAL_STATE"
  | "E_EGRESS_APPROVAL_EXPIRED"
  | "E_EGRESS_APPROVAL_CONSUMED"
  | "E_EGRESS_APPROVAL_REVOKED"
  | "E_EGRESS_APPROVAL_UNVERIFIED";

export type EgressDeniedDimension =
  | "endpoint"
  | "model"
  | "data_class"
  | "project_exclusion"
  | "byte_limit"
  | "approval";

interface EgressErrorInit {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly message_key: string;
  readonly stage: string;
  readonly details: ErrorDetails;
}

function buildError(init: EgressErrorInit): ErrorEnvelope {
  return makeErrorEnvelope({
    code: init.code,
    category: init.category,
    message_key: init.message_key,
    stage: init.stage,
    details: init.details,
  });
}

/**
 * `E_EGRESS_REQUEST_PREIMAGE` and `E_EGRESS_REQUEST_INVALID` carry no extra
 * detail branch; the caller-visible text is derived from `message_key`.
 */
export function egressRequestPreimageError(): ErrorEnvelope {
  return buildError({
    code: "E_EGRESS_REQUEST_PREIMAGE",
    category: "schema",
    message_key: "error.egress_request_preimage",
    stage: "egress_request",
    details: { kind: "none" },
  });
}

export function egressRequestInvalidError(): ErrorEnvelope {
  return buildError({
    code: "E_EGRESS_REQUEST_INVALID",
    category: "schema",
    message_key: "error.egress_request_invalid",
    stage: "egress_request",
    details: { kind: "none" },
  });
}

export function egressRequestHashError(): ErrorEnvelope {
  return buildError({
    code: "E_EGRESS_REQUEST_HASH",
    category: "conflict",
    message_key: "error.egress_request_hash",
    stage: "egress_request",
    details: { kind: "none" },
  });
}

export function egressPolicyStaleError(policyVersion: string): ErrorEnvelope {
  return buildError({
    code: "E_EGRESS_POLICY_STALE",
    category: "version",
    message_key: "error.egress_policy_stale",
    stage: "egress_policy",
    details: { kind: "none" },
  });
}

export function egressByteLimitError(
  policyVersion: string,
  refs: readonly SourceRef[],
): ErrorEnvelope {
  const first = refs[0];
  return buildError({
    code: "E_EGRESS_BYTE_LIMIT",
    category: "source",
    message_key: "error.egress_byte_limit",
    stage: "egress_evaluate",
    details:
      first === undefined
        ? { kind: "none" }
        : { kind: "source", source_ref: first, reason: "too_large" },
  });
}

export function egressApprovalNotFoundError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_NOT_FOUND", "not_found", policyVersion);
}

export function egressApprovalMismatchError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_MISMATCH", "conflict", policyVersion);
}

export function egressApprovalStateError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_STATE", "conflict", policyVersion);
}

export function egressApprovalExpiredError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_EXPIRED", "authorization", policyVersion);
}

export function egressApprovalConsumedError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_CONSUMED", "authorization", policyVersion);
}

export function egressApprovalRevokedError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_REVOKED", "authorization", policyVersion);
}

export function egressApprovalUnverifiedError(policyVersion: string): ErrorEnvelope {
  return approvalError("E_EGRESS_APPROVAL_UNVERIFIED", "authorization", policyVersion);
}

export function egressSchemaError(path: string, rule: string): ErrorEnvelope {
  return buildError({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "egress_schema",
    details: { kind: "field", path, rule },
  });
}

export function egressInternalError(incidentId: string): ErrorEnvelope {
  return buildError({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage: "egress_internal",
    details: { kind: "internal", incident_id: incidentId },
  });
}

export function egressStaleVersionError(expected: string, actual: string): ErrorEnvelope {
  return buildError({
    code: "E_STALE_VERSION",
    category: "version",
    message_key: "error.stale_version",
    stage: "egress_cas",
    details: { kind: "version", expected, actual },
  });
}

function approvalError(
  code: EgressErrorCode,
  category: ErrorCategory,
  policyVersion: string,
): ErrorEnvelope {
  return buildError({
    code,
    category,
    message_key: `error.${code.toLowerCase()}`,
    stage: "egress_approve",
    details: {
      kind: "egress",
      policy_version: policyVersion,
      denied_dimension: "approval",
      refs: [],
    },
  });
}
