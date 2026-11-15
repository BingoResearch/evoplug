/**
 * Wire request parsers for replay IPC methods (DD-FND-042, DD-FND-096).
 *
 * Parsing is separate from authorization: these functions validate shape and
 * closed unions only, and never verify attestations, read plans or consume
 * approvals.
 */

import { err, isHash, isId, ok, parseSourceRef } from "@evoplug/core";
import type { ErrorEnvelope, FailureStatus, Hash, Id, Result, SourceRef } from "@evoplug/core";
import { parseHumanAttestation } from "@evoplug/egress";

import { replaySchemaError } from "./errors.js";
import { isValidFencingToken } from "./execution.js";
import {
  REPLAY_APPROVE_SCHEMA_VERSION,
  REPLAY_MAX_REASON_BYTES,
  REPLAY_MAX_TTL_MS,
  REPLAY_MIN_TTL_MS,
  REPLAY_RECONCILE_SCHEMA_VERSION,
  REPLAY_REJECT_SCHEMA_VERSION,
  REPLAY_REVOKE_SCHEMA_VERSION,
  type ReplayApproveRequest,
  type ReplayReconcileRequest,
  type ReplayRejectRequest,
  type ReplayRevokeRequest,
} from "./types.js";

export const REPLAY_AUTHORIZE_SCHEMA_VERSION: "rsi.replay_authorize/1" =
  "rsi.replay_authorize/1";

export const REPLAY_EXECUTE_SCHEMA_VERSION: "rsi.replay_execute/1" =
  "rsi.replay_execute/1";

export interface ReplayAuthorizeRequestShape {
  schema_version: "rsi.replay_authorize/1";
  replay_plan_id: Id<"rpl">;
  approval_id: Id<"rpa"> | null;
}

export interface ReplayExecuteRequestShape {
  schema_version: "rsi.replay_execute/1";
  replay_plan_id: Id<"rpl">;
  expected_plan_hash: Hash;
  approval_id: Id<"rpa"> | null;
}

/**
 * Success shape of `parseReplayApproveRequest`.
 *
 * The idempotency key is echoed at the top level as well as inside `value`:
 * DD-FND-096.1 step 1 validates the key before the plan read, and callers
 * that only hold the parse result still need to know which key the request
 * carried.
 */
export type ReplayApproveParseResult =
  | ({ ok: true; status: "ok"; value: ReplayApproveRequest } & { idempotency_key: string })
  | { ok: false; status: FailureStatus; error: ErrorEnvelope };

export function parseReplayApproveRequest(
  value: unknown,
): ReplayApproveParseResult {
  const record = asRecord(value, "replay.approve");
  if (!record.ok) {
    return record;
  }
  const fields = new Set([
    "schema_version",
    "replay_plan_id",
    "expected_plan_hash",
    "ttl_ms",
    "human_attestation",
    "reason",
  ]);
  const shape = checkFields(record.value, fields, ["idempotency_key"]);
  if (shape !== null) {
    return err(shape);
  }
  const idempotencyKey = parseOptionalIdempotencyKey(record.value["idempotency_key"]);
  if (idempotencyKey === null) {
    return err(replaySchemaError("idempotency_key", "1..128_pattern"));
  }
  if (record.value["schema_version"] !== REPLAY_APPROVE_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_APPROVE_SCHEMA_VERSION));
  }
  const planId = parseRequiredId(record.value["replay_plan_id"], "rpl", "replay_plan_id");
  if (!planId.ok) {
    return planId;
  }
  const planHash = parseRequiredHash(record.value["expected_plan_hash"], "expected_plan_hash");
  if (!planHash.ok) {
    return planHash;
  }
  const ttlFailure = validateTtl(record.value["ttl_ms"]);
  if (ttlFailure !== null) {
    return err(ttlFailure);
  }
  const reasonFailure = validateReason(record.value["reason"]);
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  const attestation = parseHumanAttestation(record.value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  return {
    ok: true,
    status: "ok",
    idempotency_key: idempotencyKey,
    value: {
      schema_version: REPLAY_APPROVE_SCHEMA_VERSION,
      replay_plan_id: planId.value,
      expected_plan_hash: planHash.value,
      ttl_ms: record.value["ttl_ms"] as number,
      human_attestation: attestation.value,
      reason: record.value["reason"] as string,
      idempotency_key: idempotencyKey,
    }
  };
}

export function parseReplayRevokeRequest(
  value: unknown,
): Result<ReplayRevokeRequest, ErrorEnvelope> {
  const record = asRecord(value, "replay.revoke");
  if (!record.ok) {
    return record;
  }
  const fields = new Set([
    "schema_version",
    "approval_id",
    "expected_approval_hash",
    "human_attestation",
    "reason",
  ]);
  const shape = checkFields(record.value, fields);
  if (shape !== null) {
    return err(shape);
  }
  if (record.value["schema_version"] !== REPLAY_REVOKE_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_REVOKE_SCHEMA_VERSION));
  }
  const approvalId = parseRequiredId(record.value["approval_id"], "rpa", "approval_id");
  if (!approvalId.ok) {
    return approvalId;
  }
  const approvalHash = parseRequiredHash(
    record.value["expected_approval_hash"],
    "expected_approval_hash",
  );
  if (!approvalHash.ok) {
    return approvalHash;
  }
  const reason = record.value["reason"];
  if (reason !== "human_revoked" && reason !== "policy_replaced") {
    return err(replaySchemaError("reason", "human_revoked_or_policy_replaced"));
  }
  const attestation = parseHumanAttestation(record.value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  return ok({
    schema_version: REPLAY_REVOKE_SCHEMA_VERSION,
    approval_id: approvalId.value,
    expected_approval_hash: approvalHash.value,
    human_attestation: attestation.value,
    reason,
  });
}

export function parseReplayRejectRequest(
  value: unknown,
): Result<ReplayRejectRequest, ErrorEnvelope> {
  const record = asRecord(value, "replay.reject");
  if (!record.ok) {
    return record;
  }
  const fields = new Set([
    "schema_version",
    "replay_plan_id",
    "expected_plan_hash",
    "human_attestation",
    "reason",
  ]);
  const shape = checkFields(record.value, fields);
  if (shape !== null) {
    return err(shape);
  }
  if (record.value["schema_version"] !== REPLAY_REJECT_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_REJECT_SCHEMA_VERSION));
  }
  const planId = parseRequiredId(record.value["replay_plan_id"], "rpl", "replay_plan_id");
  if (!planId.ok) {
    return planId;
  }
  const planHash = parseRequiredHash(record.value["expected_plan_hash"], "expected_plan_hash");
  if (!planHash.ok) {
    return planHash;
  }
  const reasonFailure = validateReason(record.value["reason"]);
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  const attestation = parseHumanAttestation(record.value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  return ok({
    schema_version: REPLAY_REJECT_SCHEMA_VERSION,
    replay_plan_id: planId.value,
    expected_plan_hash: planHash.value,
    human_attestation: attestation.value,
    reason: record.value["reason"] as string,
  });
}

export function parseReplayReconcileRequest(
  value: unknown,
): Result<ReplayReconcileRequest, ErrorEnvelope> {
  const record = asRecord(value, "replay.reconcile");
  if (!record.ok) {
    return record;
  }
  const fields = new Set([
    "schema_version",
    "execution_id",
    "fencing_token",
    "evidence_ref",
    "human_attestation",
    "reason",
  ]);
  const shape = checkFields(record.value, fields);
  if (shape !== null) {
    return err(shape);
  }
  if (record.value["schema_version"] !== REPLAY_RECONCILE_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_RECONCILE_SCHEMA_VERSION));
  }
  const executionId = parseRequiredId(record.value["execution_id"], "rex", "execution_id");
  if (!executionId.ok) {
    return executionId;
  }
  const token = record.value["fencing_token"];
  if (typeof token !== "string" || !isValidFencingToken(token)) {
    return err(replaySchemaError("fencing_token", "base64url_43"));
  }
  const evidence = parseEvidenceRef(record.value["evidence_ref"]);
  if (!evidence.ok) {
    return evidence;
  }
  const reasonFailure = validateReason(record.value["reason"]);
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  const attestation = parseHumanAttestation(record.value["human_attestation"]);
  if (!attestation.ok) {
    return attestation;
  }
  return ok({
    schema_version: REPLAY_RECONCILE_SCHEMA_VERSION,
    execution_id: executionId.value,
    fencing_token: token,
    evidence_ref: evidence.value,
    human_attestation: attestation.value,
    reason: record.value["reason"] as string,
  });
}

export function parseReplayAuthorizeRequest(
  value: unknown,
): Result<ReplayAuthorizeRequestShape, ErrorEnvelope> {
  const record = asRecord(value, "replay.authorize");
  if (!record.ok) {
    return record;
  }
  const shape = checkFields(
    record.value,
    new Set(["schema_version", "replay_plan_id", "approval_id"]),
  );
  if (shape !== null) {
    return err(shape);
  }
  if (record.value["schema_version"] !== REPLAY_AUTHORIZE_SCHEMA_VERSION) {
    return err(replaySchemaError("schema_version", REPLAY_AUTHORIZE_SCHEMA_VERSION));
  }
  const planId = parseRequiredId(record.value["replay_plan_id"], "rpl", "replay_plan_id");
  if (!planId.ok) {
    return planId;
  }
  const approval = parseOptionalId(record.value["approval_id"], "rpa", "approval_id");
  if (!approval.ok) {
    return approval;
  }
  return ok({
    schema_version: REPLAY_AUTHORIZE_SCHEMA_VERSION,
    replay_plan_id: planId.value,
    approval_id: approval.value,
  });
}

export function parseReplayExecuteRequest(
  value: unknown,
): Result<ReplayExecuteRequestShape, ErrorEnvelope> {
  const record = asRecord(value, "replay.execute");
  if (!record.ok) {
    return record;
  }
  const shape = checkFields(
    record.value,
    new Set(["replay_plan_id", "expected_plan_hash", "approval_id"]),
  );
  if (shape !== null) {
    return err(shape);
  }
  const planId = parseRequiredId(record.value["replay_plan_id"], "rpl", "replay_plan_id");
  if (!planId.ok) {
    return planId;
  }
  const planHash = parseRequiredHash(record.value["expected_plan_hash"], "expected_plan_hash");
  if (!planHash.ok) {
    return planHash;
  }
  const approval = parseOptionalId(record.value["approval_id"], "rpa", "approval_id");
  if (!approval.ok) {
    return approval;
  }
  return ok({
    schema_version: REPLAY_EXECUTE_SCHEMA_VERSION,
    replay_plan_id: planId.value,
    expected_plan_hash: planHash.value,
    approval_id: approval.value,
  });
}

function asRecord(value: unknown, path: string): Result<Record<string, unknown>, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(replaySchemaError(path, "object"));
  }
  return ok(value as Record<string, unknown>);
}

function checkFields(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
  optional: readonly string[] = [],
): ErrorEnvelope | null {
  const optionalSet = new Set(optional);
  for (const key of Object.keys(record)) {
    if (!fields.has(key) && !optionalSet.has(key)) {
      return replaySchemaError(key, "known_field");
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return replaySchemaError(field, "required");
    }
  }
  return null;
}

/**
 * Optional control-plane idempotency key. DD-FND-096.1 validates the key before
 * the plan read; the IPC envelope normally carries it, but the wire request
 * also accepts it so a same-key replay can be issued directly.
 */
function parseOptionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return null;
  }
  return value;
}

function parseRequiredId<P extends "rpl" | "rpa" | "rex">(
  value: unknown,
  prefix: P,
  path: string,
): Result<Id<P>, ErrorEnvelope> {
  if (typeof value !== "string" || !isId(value, prefix)) {
    return err(replaySchemaError(path, `${prefix}_id`));
  }
  return ok(value);
}

function parseOptionalId(
  value: unknown,
  prefix: "rpa",
  path: string,
): Result<Id<"rpa"> | null, ErrorEnvelope> {
  if (value === null) {
    return ok(null);
  }
  if (typeof value !== "string" || !isId(value, prefix)) {
    return err(replaySchemaError(path, `${prefix}_id_or_null`));
  }
  return ok(value);
}

function parseRequiredHash(value: unknown, path: string): Result<Hash, ErrorEnvelope> {
  if (typeof value !== "string" || !isHash(value)) {
    return err(replaySchemaError(path, "sha256_full_hash"));
  }
  return ok(value);
}

function parseEvidenceRef(value: unknown): Result<SourceRef, ErrorEnvelope> {
  if (typeof value !== "string") {
    return err(replaySchemaError("evidence_ref", "source_ref"));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(parsed.value.source_ref);
}

function validateTtl(value: unknown): ErrorEnvelope | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < REPLAY_MIN_TTL_MS ||
    value > REPLAY_MAX_TTL_MS
  ) {
    return replaySchemaError("ttl_ms", "1_600000");
  }
  return null;
}

function validateReason(value: unknown): ErrorEnvelope | null {
  if (typeof value !== "string" || value.length === 0) {
    return replaySchemaError("reason", "non_empty_string");
  }
  if (new TextEncoder().encode(value).length > REPLAY_MAX_REASON_BYTES) {
    return replaySchemaError("reason", `max_${String(REPLAY_MAX_REASON_BYTES)}_bytes`);
  }
  return null;
}
