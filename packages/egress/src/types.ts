/**
 * EgressPolicy, request, decision and approval shapes (DD-FND-093,
 * DD-FND-097.6).
 *
 * These declarations are the single TypeScript source for the egress wire
 * objects. Schema versions, field names and closed unions are copied verbatim
 * from the design; no field is defaulted or renamed.
 */

import type {
  Hash,
  Id,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";

import type { HumanAttestation } from "./ports.js";

export type DataClass = "public" | "user_text" | "source_code" | "tool_output" | "secret";

/** Data classes that an endpoint rule may authorise; `secret` is never one. */
export type EgressAllowedDataClass = Exclude<DataClass, "secret">;

export interface EgressEndpointRule {
  scheme: "https";
  /** Lowercase IDNA ASCII; user info, wildcards and fragments are rejected. */
  host: string;
  port: number;
  path_prefix: string;
  models: string[];
  data_classes: EgressAllowedDataClass[];
  max_request_bytes: number;
}

export interface EgressPolicy {
  schema_version: "rsi.egress_policy/1";
  policy_version: string;
  default_decision: "deny";
  endpoints: EgressEndpointRule[];
  project_exclusions: string[];
  max_source_refs: number;
  permission_for_replay: "same_policy" | "deny";
}

type EgressPurpose = "judge" | "review_generate" | "review_match" | "replay" | "other";

export interface EgressEndpoint {
  scheme: "https";
  host: string;
  port: number;
  /** Origin-form request target including the query string, starting with "/". */
  path: string;
}

export interface EgressRequestSource {
  ref: SourceRef;
  data_class: DataClass;
}

export interface EgressRequestInput {
  schema_version: "rsi.egress_request/1";
  binding: VersionBinding;
  purpose: EgressPurpose;
  endpoint: EgressEndpoint;
  model: string;
  project_id: string;
  sources: EgressRequestSource[];
  body_sha256: Hash;
  byte_length: number;
  replay_plan_id: Id<"rpl"> | null;
}

export interface EgressRequest extends EgressRequestInput {
  /** Frozen by `egress.evaluate` from the current `EgressPolicy`. */
  policy_version: string;
  /** Derived by the server from the DD-FND-097.6 preimage; never trusted input. */
  request_hash: Hash;
}

type EgressFindingDimension =
  | "endpoint"
  | "model"
  | "data_class"
  | "source"
  | "project"
  | "bytes";

export interface EgressFinding {
  dimension: EgressFindingDimension;
  ref: string | null;
  passed: boolean;
}

export type EgressDenyReason =
  | "endpoint_not_allowed"
  | "model_not_allowed"
  | "data_class_not_allowed"
  | "secret_forbidden"
  | "project_excluded"
  | "source_not_allowed"
  | "source_count_exceeded"
  | "byte_limit_exceeded"
  | "source_unretrievable"
  | "binding_mismatch"
  | "replay_policy_denied";

export type EgressDecision =
  | {
      allowed: true;
      request: EgressRequest;
      policy_version: string;
      approval_id: Id<"egr"> | null;
      findings: EgressFinding[];
    }
  | {
      allowed: false;
      request: EgressRequest;
      reason_code: EgressDenyReason;
      findings: EgressFinding[];
    }
  | {
      allowed: false;
      request: EgressRequest;
      reason_code: "approval_required";
      findings: EgressFinding[];
      /** Always equals `request.request_hash` (DD-FND-093). */
      approval_request_hash: Hash;
    };

type EgressApprovalState = "active" | "consumed" | "revoked" | "expired";

export type EgressRevokeReason = "human_revoked" | "policy_replaced";

export interface EgressApproval {
  approval_id: Id<"egr">;
  policy_version: string;
  approved_by: "human";
  human_attestation: HumanAttestation;
  attestation_subject_hash: Hash;
  request_hash: Hash;
  approval_hash: Hash;
  purpose: EgressPurpose;
  version_binding: VersionBinding;
  /** scheme/host/port/path are each bound. */
  endpoint: EgressEndpoint;
  model: string;
  project_id: string;
  sources: EgressRequestSource[];
  body_sha256: Hash;
  byte_length: number;
  replay_plan_id: Id<"rpl"> | null;
  ttl_ms: number;
  state: EgressApprovalState;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_request_hash: Hash | null;
  revoked_at: number | null;
  revoke_reason: EgressRevokeReason | null;
  row_version: number;
}

export type EgressApprovalView = Omit<EgressApproval, "human_attestation">;

export interface EgressApprovalRequest {
  schema_version: "rsi.egress_approval_request/1";
  /** Full preimage is mandatory; a bare `request_hash` can never be approved. */
  request: EgressRequest;
  ttl_ms: number;
  human_attestation: HumanAttestation;
}

/** Minimum and maximum single-use approval TTL (DD-FND-093 rule 7). */
export const EGRESS_APPROVAL_MIN_TTL_MS = 1;
export const EGRESS_APPROVAL_MAX_TTL_MS = 600_000;

/** Maximum serialised request body accepted by any endpoint rule. */
export const EGRESS_MAX_REQUEST_BYTES = 16_777_216;

/** Maximum length of an origin-form request target in bytes. */
export const EGRESS_MAX_PATH_BYTES = 8_192;

export const EGRESS_REQUEST_SCHEMA_VERSION: "rsi.egress_request/1" = "rsi.egress_request/1";

export const EGRESS_POLICY_SCHEMA_VERSION: "rsi.egress_policy/1" = "rsi.egress_policy/1";

export const EGRESS_APPROVAL_REQUEST_SCHEMA_VERSION: "rsi.egress_approval_request/1" =
  "rsi.egress_approval_request/1";

export function isDataClass(value: string): value is DataClass {
  switch (value) {
    case "public":
    case "user_text":
    case "source_code":
    case "tool_output":
    case "secret":
      return true;
    default:
      return false;
  }
}

export function isEgressPurpose(value: string): value is EgressPurpose {
  return (
    value === "judge" ||
    value === "review_generate" ||
    value === "review_match" ||
    value === "replay" ||
    value === "other"
  );
}

