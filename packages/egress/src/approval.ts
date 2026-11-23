/**
 * Single-use `EgressApproval` issuance and consumption (DD-FND-093 rule 7,
 * DD-FND-097.6).
 *
 * `approval_hash` covers the full bound preimage including `approval_id`, so
 * re-issuing the same request after consumption produces a different hash and
 * cannot collide with the unique index. `request_hash` alone is never a
 * consumable preimage: every consumption compares all bound fields.
 */

import {
  canonicalHash,
  equalVersionBinding,
  err,
  isHash,
  ok,
} from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
} from "@evoplug/core";

import {
  egressApprovalConsumedError,
  egressApprovalExpiredError,
  egressApprovalMismatchError,
  egressApprovalRevokedError,
  egressApprovalStateError,
  egressRequestHashError,
  egressSchemaError,
} from "./errors.js";
import { parseEgressRequest, recomputeEgressRequestHash } from "./request.js";
import { parseHumanAttestation, type HumanAttestation } from "./ports.js";
import {
  EGRESS_APPROVAL_MAX_TTL_MS,
  EGRESS_APPROVAL_MIN_TTL_MS,
  EGRESS_APPROVAL_REQUEST_SCHEMA_VERSION,
  type EgressApproval,
  type EgressApprovalRequest,
  type EgressApprovalView,
  type EgressRequest,
  type EgressRequestSource,
  type EgressRevokeReason,
} from "./types.js";

const EGRESS_APPROVAL_SUBJECT_SCHEMA_VERSION: "rsi.egress_approval_subject/1" =
  "rsi.egress_approval_subject/1";

const EGRESS_APPROVAL_HASH_SCHEMA_VERSION: "rsi.egress_approval_hash/2" =
  "rsi.egress_approval_hash/2";

interface EgressApprovalSubjectInput {
  readonly request_hash: Hash;
  readonly policy_version: string;
  readonly ttl_ms: number;
}

interface CreateEgressApprovalInput {
  readonly approval_id: Id<"egr">;
  readonly request: EgressRequest;
  readonly policy_version: string;
  readonly ttl_ms: number;
  readonly now_ms: number;
  readonly human_attestation: HumanAttestation;
}

/** Parses the `egress.approve` wire request; a bare hash is rejected. */
export function parseEgressApprovalRequest(
  value: unknown,
): Result<EgressApprovalRequest, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([
    "schema_version",
    "request",
    "ttl_ms",
    "human_attestation",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return err(egressSchemaError(key, "known_field"));
    }
  }
  if (record["schema_version"] !== EGRESS_APPROVAL_REQUEST_SCHEMA_VERSION) {
    return err(
      egressSchemaError("schema_version", EGRESS_APPROVAL_REQUEST_SCHEMA_VERSION),
    );
  }
  const request = parseEgressRequest(record["request"]);
  if (!request.ok) {
    return request;
  }
  const ttl = record["ttl_ms"];
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < EGRESS_APPROVAL_MIN_TTL_MS ||
    ttl > EGRESS_APPROVAL_MAX_TTL_MS
  ) {
    return err(egressSchemaError("ttl_ms", "1_600000"));
  }
  const attestation = parseHumanAttestation(record["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  return ok({
    schema_version: EGRESS_APPROVAL_REQUEST_SCHEMA_VERSION,
    request: request.value,
    ttl_ms: ttl,
    human_attestation: attestation.value,
  });
}

/**
 * `attestation_subject_hash = sha256(JCS({schema_version, purpose,
 * request_hash, policy_version, ttl_ms}))`.
 */
export function computeEgressApprovalSubjectHash(input: EgressApprovalSubjectInput): Hash {
  const preimage: JsonValue = {
    schema_version: EGRESS_APPROVAL_SUBJECT_SCHEMA_VERSION,
    purpose: "egress_approve",
    request_hash: input.request_hash,
    policy_version: input.policy_version,
    ttl_ms: input.ttl_ms,
  };
  return canonicalHash(preimage);
}

/**
 * `approval_hash = sha256(JCS(preimage))` over the DD-FND-097.6 white list.
 * State, timestamps, consumption and revocation fields never enter it.
 */
export function computeEgressApprovalHash(
  approval: Omit<EgressApproval, "approval_hash">,
): Hash {
  const sortedSources = sortSources(approval.sources);
  const preimage: JsonValue = {
    schema_version: EGRESS_APPROVAL_HASH_SCHEMA_VERSION,
    approval_id: approval.approval_id,
    request_hash: approval.request_hash,
    policy_version: approval.policy_version,
    approved_by: approval.approved_by,
    attestation_subject_hash: approval.attestation_subject_hash,
    purpose: approval.purpose,
    version_binding: {
      task_id: approval.version_binding.task_id,
      branch_id: approval.version_binding.branch_id,
      input_epoch: approval.version_binding.input_epoch,
      goal_version: approval.version_binding.goal_version,
      config_version: approval.version_binding.config_version,
      watermark: approval.version_binding.watermark,
    },
    endpoint: {
      scheme: approval.endpoint.scheme,
      host: approval.endpoint.host,
      port: approval.endpoint.port,
      path: approval.endpoint.path,
    },
    model: approval.model,
    project_id: approval.project_id,
    sources: sortedSources.map((source) => ({
      ref: source.ref,
      data_class: source.data_class,
    })),
    body_sha256: approval.body_sha256,
    byte_length: approval.byte_length,
    replay_plan_id: approval.replay_plan_id,
    ttl_ms: approval.ttl_ms,
  };
  return canonicalHash(preimage);
}

/**
 * Builds an active approval. The caller must already have verified the
 * control-plane attestation with `purpose="egress_approve"`; this function
 * only freezes the bound preimage.
 */
export function createEgressApproval(
  input: CreateEgressApprovalInput,
): Result<EgressApproval, ErrorEnvelope> {
  if (
    !Number.isSafeInteger(input.ttl_ms) ||
    input.ttl_ms < EGRESS_APPROVAL_MIN_TTL_MS ||
    input.ttl_ms > EGRESS_APPROVAL_MAX_TTL_MS
  ) {
    return err(egressSchemaError("ttl_ms", "1_600000"));
  }
  if (!Number.isSafeInteger(input.now_ms) || input.now_ms < 0) {
    return err(egressSchemaError("now_ms", "epoch_ms"));
  }
  if (input.policy_version !== input.request.policy_version) {
    return err(egressSchemaError("policy_version", "matches_request"));
  }
  const verified = verifyEgressRequestHashForApproval(input.request);
  if (!verified.ok) {
    return verified;
  }
  const attestationSubjectHash = computeEgressApprovalSubjectHash({
    request_hash: input.request.request_hash,
    policy_version: input.policy_version,
    ttl_ms: input.ttl_ms,
  });
  const withoutHash: Omit<EgressApproval, "approval_hash"> = {
    approval_id: input.approval_id,
    policy_version: input.policy_version,
    approved_by: "human",
    human_attestation: input.human_attestation,
    attestation_subject_hash: attestationSubjectHash,
    request_hash: input.request.request_hash,
    purpose: input.request.purpose,
    version_binding: input.request.binding,
    endpoint: input.request.endpoint,
    model: input.request.model,
    project_id: input.request.project_id,
    sources: sortSources(input.request.sources),
    body_sha256: input.request.body_sha256,
    byte_length: input.request.byte_length,
    replay_plan_id: input.request.replay_plan_id,
    ttl_ms: input.ttl_ms,
    state: "active",
    created_at: input.now_ms,
    expires_at: input.now_ms + input.ttl_ms,
    consumed_at: null,
    consumed_request_hash: null,
    revoked_at: null,
    revoke_reason: null,
    row_version: 1,
  };
  return ok({
    ...withoutHash,
    approval_hash: computeEgressApprovalHash(withoutHash),
  });
}

/** True when an approval covers exactly this request and is still usable. */
export function egressApprovalCoversRequest(
  approval: EgressApproval,
  request: EgressRequest,
  nowMs: number,
): boolean {
  if (approval.state !== "active" || approval.expires_at <= nowMs) {
    return false;
  }
  if (approval.request_hash !== request.request_hash) {
    return false;
  }
  if (approval.policy_version !== request.policy_version) {
    return false;
  }
  if (approval.approval_hash !== computeEgressApprovalHash(approval)) {
    return false;
  }
  return boundFieldsEqual(approval, request);
}

/**
 * Validates the approval for a concrete send. Check order follows
 * DD-FND-097.6: state first, then the full field-by-field comparison.
 */
export function validateEgressApprovalForSend(
  approval: EgressApproval,
  request: EgressRequest,
  nowMs: number,
): Result<EgressApproval, ErrorEnvelope> {
  const policyVersion = approval.policy_version;
  switch (approval.state) {
    case "consumed":
      return err(egressApprovalConsumedError(policyVersion));
    case "revoked":
      return err(egressApprovalRevokedError(policyVersion));
    case "expired":
      return err(egressApprovalExpiredError(policyVersion));
    case "active":
      if (approval.expires_at <= nowMs) {
        return err(egressApprovalExpiredError(policyVersion));
      }
      break;
    default:
      return err(egressApprovalStateError(policyVersion));
  }
  if (
    request.request_hash !== recomputeEgressRequestHash(request) ||
    approval.request_hash !== request.request_hash
  ) {
    return err(egressApprovalMismatchError(policyVersion));
  }
  if (!boundFieldsEqual(approval, request)) {
    return err(egressApprovalMismatchError(policyVersion));
  }
  if (approval.approval_hash !== computeEgressApprovalHash(approval)) {
    return err(egressApprovalMismatchError(policyVersion));
  }
  return ok(approval);
}

/**
 * Atomically describes the `active → consumed` transition. The caller must
 * fsync `egress.approval_transition` and CAS on
 * `(approval_id,row_version,state='active',expires_at > now)` before any
 * network call.
 */
export function consumeEgressApproval(
  approval: EgressApproval,
  request: EgressRequest,
  nowMs: number,
): Result<EgressApproval, ErrorEnvelope> {
  const valid = validateEgressApprovalForSend(approval, request, nowMs);
  if (!valid.ok) {
    return valid;
  }
  return ok({
    ...approval,
    state: "consumed",
    consumed_at: nowMs,
    consumed_request_hash: request.request_hash,
    row_version: approval.row_version + 1,
  });
}

/** `active → revoked`; any other state is rejected with its canonical code. */
export function revokeEgressApproval(
  approval: EgressApproval,
  nowMs: number,
  reason: EgressRevokeReason,
): Result<EgressApproval, ErrorEnvelope> {
  const policyVersion = approval.policy_version;
  switch (approval.state) {
    case "consumed":
      return err(egressApprovalConsumedError(policyVersion));
    case "revoked":
      return err(egressApprovalRevokedError(policyVersion));
    case "expired":
      return err(egressApprovalExpiredError(policyVersion));
    case "active":
      break;
    default:
      return err(egressApprovalStateError(policyVersion));
  }
  return ok({
    ...approval,
    state: "revoked",
    revoked_at: nowMs,
    revoke_reason: reason,
    row_version: approval.row_version + 1,
  });
}

/** Strips the attestation text for IPC responses. */
export function toEgressApprovalView(approval: EgressApproval): EgressApprovalView {
  const { human_attestation: _attestation, ...view } = approval;
  return view;
}

function verifyEgressRequestHashForApproval(
  request: EgressRequest,
): Result<EgressRequest, ErrorEnvelope> {
  if (!isHash(request.request_hash)) {
    return err(egressSchemaError("request_hash", "sha256_full_hash"));
  }
  if (request.request_hash !== recomputeEgressRequestHash(request)) {
    return err(egressRequestHashError());
  }
  return ok(request);
}

function boundFieldsEqual(approval: EgressApproval, request: EgressRequest): boolean {
  if (!equalVersionBinding(approval.version_binding, request.binding)) {
    return false;
  }
  if (
    approval.purpose !== request.purpose ||
    approval.model !== request.model ||
    approval.project_id !== request.project_id ||
    approval.body_sha256 !== request.body_sha256 ||
    approval.byte_length !== request.byte_length ||
    approval.replay_plan_id !== request.replay_plan_id
  ) {
    return false;
  }
  if (
    approval.endpoint.scheme !== request.endpoint.scheme ||
    approval.endpoint.host !== request.endpoint.host ||
    approval.endpoint.port !== request.endpoint.port ||
    approval.endpoint.path !== request.endpoint.path
  ) {
    return false;
  }
  const left = sortSources(approval.sources);
  const right = sortSources(request.sources);
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (a.ref !== b.ref || a.data_class !== b.data_class) {
      return false;
    }
  }
  return true;
}

function sortSources(sources: readonly EgressRequestSource[]): EgressRequestSource[] {
  return [...sources].sort((left, right) => {
    if (left.ref < right.ref) {
      return -1;
    }
    if (left.ref > right.ref) {
      return 1;
    }
    if (left.data_class < right.data_class) {
      return -1;
    }
    if (left.data_class > right.data_class) {
      return 1;
    }
    return 0;
  });
}
