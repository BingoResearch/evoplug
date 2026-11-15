/**
 * Delivery three-axis state machine (DD-FND-092).
 *
 * Transport: pending → submitted → expired|failed, or pending → expired|failed.
 * Inclusion: strictly non-decreasing across
 * unknown < context_projection < provider_payload < transport_body < host_confirmed.
 * Adoption: independently non-decreasing across unknown < observed < verified.
 *
 * Terminal reasons are written atomically when the transport axis becomes
 * terminal and are never cleared or overwritten by late ACKs or evidence
 * updates. `expired_by_time` can only be written by the outbox expiry path.
 */

import { err, isId, ok, parseSourceRef } from "@evoplug/core";
import type { ErrorEnvelope, Result, SourceRef } from "@evoplug/core";

import { deliverySchemaError, deliveryStaleVersionError } from "./errors.js";
import {
  ADOPTION_EVIDENCE_RANK,
  DELIVERY_UPDATE_SCHEMA_VERSION,
  INCLUSION_EVIDENCE_RANK,
  isAdoptionEvidence,
  isDeliveryTerminal,
  isInclusionEvidence,
  type AdoptionEvidence,
  type DeliveryAdoptionVerifier,
  type DeliveryHistoryEntry,
  type DeliveryHistoryNoteCode,
  type DeliveryRecord,
  type DeliveryTerminalReason,
  type DeliveryUpdateOutcome,
  type DeliveryUpdateRequest,
  type InclusionEvidence,
} from "./types.js";

export interface DeliveryUpdateContext {
  readonly now_ms: number;
  /** Set by the caller after resolving the update's `evidence_ref`. */
  readonly evidence_retrievable: boolean;
  /** Verified `HumanAttestation` bound to the adoption evidence ref. */
  readonly human_attestation_verified: boolean;
}

/**
 * Parses a `DeliveryUpdateRequest` from the IPC boundary. Exactly one axis is
 * accepted per call; a single request can never write two axes.
 */
export function parseDeliveryUpdateRequest(
  value: unknown,
): Result<DeliveryUpdateRequest, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(deliverySchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  const rootFields = new Set([
    "schema_version",
    "delivery_id",
    "expected_row_version",
    "update",
  ]);
  for (const key of Object.keys(record)) {
    if (!rootFields.has(key)) {
      return err(deliverySchemaError(key, "known_field"));
    }
  }
  for (const field of rootFields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(deliverySchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== DELIVERY_UPDATE_SCHEMA_VERSION) {
    return err(deliverySchemaError("schema_version", DELIVERY_UPDATE_SCHEMA_VERSION));
  }
  const deliveryId = record["delivery_id"];
  if (typeof deliveryId !== "string" || !isId(deliveryId, "del")) {
    return err(deliverySchemaError("delivery_id", "del_id"));
  }
  const expectedRowVersion = record["expected_row_version"];
  if (
    typeof expectedRowVersion !== "number" ||
    !Number.isSafeInteger(expectedRowVersion) ||
    expectedRowVersion < 1
  ) {
    return err(deliverySchemaError("expected_row_version", "positive_safe_integer"));
  }
  const update = record["update"];
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    return err(deliverySchemaError("update", "object"));
  }
  const updateRecord = update as Record<string, unknown>;
  const axis = updateRecord["axis"];
  if (axis === "transport") {
    const state = updateRecord["state"];
    if (state === "submitted") {
      const fields = checkUpdateFields(updateRecord, ["axis", "state", "submission_ref"]);
      if (fields !== null) {
        return err(fields);
      }
      const submissionRef = updateRecord["submission_ref"];
      if (typeof submissionRef !== "string" || submissionRef.length === 0) {
        return err(deliverySchemaError("update.submission_ref", "non_empty_string"));
      }
      return ok({
        schema_version: DELIVERY_UPDATE_SCHEMA_VERSION,
        delivery_id: deliveryId,
        expected_row_version: expectedRowVersion,
        update: { axis: "transport", state: "submitted", submission_ref: submissionRef },
      });
    }
    if (state === "failed" || state === "expired") {
      const fields = checkUpdateFields(updateRecord, ["axis", "state", "reason_code"]);
      if (fields !== null) {
        return err(fields);
      }
      const reason = updateRecord["reason_code"];
      if (
        reason !== "host_rejected" &&
        reason !== "version_changed" &&
        reason !== "timeout" &&
        reason !== "cancelled"
      ) {
        return err(deliverySchemaError("update.reason_code", "manual_terminal_reason"));
      }
      return ok({
        schema_version: DELIVERY_UPDATE_SCHEMA_VERSION,
        delivery_id: deliveryId,
        expected_row_version: expectedRowVersion,
        update: { axis: "transport", state, reason_code: reason },
      });
    }
    return err(deliverySchemaError("update.state", "submitted_failed_or_expired"));
  }
  if (axis === "inclusion") {
    const fields = checkUpdateFields(updateRecord, [
      "axis",
      "evidence",
      "evidence_ref",
      "transport_body_verified",
    ]);
    if (fields !== null) {
      return err(fields);
    }
    const evidence = updateRecord["evidence"];
    if (typeof evidence !== "string" || !isInclusionEvidence(evidence)) {
      return err(deliverySchemaError("update.evidence", "inclusion_evidence"));
    }
    const evidenceRef = parseEvidenceRef(updateRecord["evidence_ref"]);
    if (!evidenceRef.ok) {
      return evidenceRef;
    }
    const verified = updateRecord["transport_body_verified"];
    if (typeof verified !== "boolean") {
      return err(deliverySchemaError("update.transport_body_verified", "boolean"));
    }
    return ok({
      schema_version: DELIVERY_UPDATE_SCHEMA_VERSION,
      delivery_id: deliveryId,
      expected_row_version: expectedRowVersion,
      update: {
        axis: "inclusion",
        evidence,
        evidence_ref: evidenceRef.value,
        transport_body_verified: verified,
      },
    });
  }
  if (axis === "adoption") {
    const fields = checkUpdateFields(updateRecord, [
      "axis",
      "adoption",
      "evidence_ref",
      "verifier",
    ]);
    if (fields !== null) {
      return err(fields);
    }
    const adoption = updateRecord["adoption"];
    if (typeof adoption !== "string" || !isAdoptionEvidence(adoption)) {
      return err(deliverySchemaError("update.adoption", "adoption_evidence"));
    }
    const evidenceRef = parseEvidenceRef(updateRecord["evidence_ref"]);
    if (!evidenceRef.ok) {
      return evidenceRef;
    }
    const verifier = updateRecord["verifier"];
    if (
      verifier !== null &&
      verifier !== "human" &&
      verifier !== "independent_artifact" &&
      verifier !== "independent_verifier"
    ) {
      return err(deliverySchemaError("update.verifier", "adoption_verifier_or_null"));
    }
    return ok({
      schema_version: DELIVERY_UPDATE_SCHEMA_VERSION,
      delivery_id: deliveryId,
      expected_row_version: expectedRowVersion,
      update: {
        axis: "adoption",
        adoption,
        evidence_ref: evidenceRef.value,
        verifier,
      },
    });
  }
  return err(deliverySchemaError("update.axis", "transport_inclusion_adoption"));
}

/**
 * Applies exactly one axis update with a `row_version` CAS. A request that
 * would change nothing returns `changed=false` and appends no history.
 */
export function applyDeliveryUpdate(
  record: DeliveryRecord,
  request: DeliveryUpdateRequest,
  context: DeliveryUpdateContext,
): Result<DeliveryUpdateOutcome, ErrorEnvelope> {
  if (request.schema_version !== DELIVERY_UPDATE_SCHEMA_VERSION) {
    return err(deliverySchemaError("schema_version", DELIVERY_UPDATE_SCHEMA_VERSION));
  }
  if (request.delivery_id !== record.delivery_id) {
    return err(deliverySchemaError("delivery_id", "matches_row"));
  }
  if (!Number.isSafeInteger(request.expected_row_version) || request.expected_row_version < 1) {
    return err(deliverySchemaError("expected_row_version", "positive_safe_integer"));
  }
  if (record.row_version !== request.expected_row_version) {
    return err(
      deliveryStaleVersionError(record.delivery_id, request.expected_row_version, record.row_version),
    );
  }
  switch (request.update.axis) {
    case "transport":
      return applyTransport(record, request.update, context.now_ms);
    case "inclusion":
      if (!context.evidence_retrievable) {
        return err(deliverySchemaError("evidence_ref", "retrievable"));
      }
      return applyInclusion(
        record,
        request.update.evidence,
        request.update.evidence_ref,
        request.update.transport_body_verified,
        context.now_ms,
      );
    case "adoption":
      if (!context.evidence_retrievable) {
        return err(deliverySchemaError("evidence_ref", "retrievable"));
      }
      return applyAdoption(
        record,
        request.update.adoption,
        request.update.evidence_ref,
        request.update.verifier,
        context,
      );
    default:
      return err(deliverySchemaError("update.axis", "transport_inclusion_adoption"));
  }
}

/**
 * Outbox `delivery.expire`: pending/submitted rows whose `expires_at` has
 * elapsed become `expired` with `expired_by_time`. Inclusion and adoption are
 * preserved, and terminal rows never revive or auto-resend.
 */
export function expireDelivery(
  record: DeliveryRecord,
  nowMs: number,
): DeliveryUpdateOutcome {
  if (record.state !== "pending" && record.state !== "submitted") {
    return unchanged(record);
  }
  if (record.expires_at > nowMs) {
    return unchanged(record);
  }
  return {
    record: {
      ...record,
      state: "expired",
      terminal_reason: "expired_by_time",
      updated_at: nowMs,
      row_version: record.row_version + 1,
    },
    changed: true,
    history_only: false,
    note_code: "expired",
    evidence_ref: null,
  };
}

export type DeliveryReceiptAxis = "transport" | "inclusion" | "adoption";

export type DeliveryReceiptEvidenceKind =
  | "hook_return_accepted"
  | "context_projection_seen"
  | "provider_payload_captured"
  | "transport_body_captured"
  | "host_confirmed"
  | "behavior_observed"
  | "independent_verifier";

export interface DeliveryReceiptInput {
  readonly delivery_id: DeliveryRecord["delivery_id"];
  readonly axis: DeliveryReceiptAxis;
  readonly evidence_kind: DeliveryReceiptEvidenceKind;
  readonly evidence_ref: DeliveryRecord["content_ref"];
  readonly observed_at: number;
  readonly expected_row_version: number;
  readonly verifier: DeliveryAdoptionVerifier | null;
}

export interface DeliveryReceiptContext {
  readonly evidence_retrievable: boolean;
}

/**
 * Host `delivery.receipt` handling. Transport receipts only append history;
 * inclusion/adoption receipts raise the monotone axis, lower-tier evidence
 * appends history without overwriting the stronger current value, and a
 * duplicate of the current level+ref is a `no_op` with no history.
 */
export function applyDeliveryReceipt(
  record: DeliveryRecord,
  receipt: DeliveryReceiptInput,
  context: DeliveryReceiptContext,
): Result<DeliveryUpdateOutcome, ErrorEnvelope> {
  if (receipt.delivery_id !== record.delivery_id) {
    return err(deliverySchemaError("delivery_id", "matches_row"));
  }
  if (record.row_version !== receipt.expected_row_version) {
    return err(
      deliveryStaleVersionError(record.delivery_id, receipt.expected_row_version, record.row_version),
    );
  }
  if (!context.evidence_retrievable) {
    return err(deliverySchemaError("evidence_ref", "retrievable"));
  }
  if (receipt.axis === "transport") {
    if (receipt.evidence_kind !== "hook_return_accepted") {
      return err(deliverySchemaError("evidence_kind", "transport_hook_return_accepted"));
    }
    // Late ACK never changes the transport state or terminal reason.
    return ok({
      record,
      changed: false,
      history_only: true,
      note_code: "late_ack",
      evidence_ref: receipt.evidence_ref,
    });
  }
  if (receipt.axis === "inclusion") {
    const evidence = inclusionFromReceipt(receipt.evidence_kind);
    if (evidence === null) {
      return err(deliverySchemaError("evidence_kind", "inclusion_mapping"));
    }
    const rank = INCLUSION_EVIDENCE_RANK[evidence];
    const current = INCLUSION_EVIDENCE_RANK[record.inclusion_evidence];
    if (rank < current) {
      return ok({
        record,
        changed: false,
        history_only: true,
        note_code: "inclusion_evidence",
        evidence_ref: receipt.evidence_ref,
      });
    }
    if (rank === current && record.inclusion_ref === receipt.evidence_ref) {
      return ok(unchanged(record));
    }
    return applyInclusion(
      record,
      evidence,
      receipt.evidence_ref,
      receipt.evidence_kind === "transport_body_captured",
      receipt.observed_at,
    );
  }
  const adoption = adoptionFromReceipt(receipt.evidence_kind);
  if (adoption === null) {
    return err(deliverySchemaError("evidence_kind", "adoption_mapping"));
  }
  const rank = ADOPTION_EVIDENCE_RANK[adoption];
  const current = ADOPTION_EVIDENCE_RANK[record.adoption];
  if (rank < current) {
    return ok({
      record,
      changed: false,
      history_only: true,
      note_code: "adoption_evidence",
      evidence_ref: receipt.evidence_ref,
    });
  }
  if (rank === current && record.adoption_ref === receipt.evidence_ref) {
    return ok(unchanged(record));
  }
  const verifier: DeliveryAdoptionVerifier | null =
    adoption === "verified" ? "independent_verifier" : receipt.verifier;
  return applyAdoption(
    record,
    adoption,
    receipt.evidence_ref,
    verifier,
    {
      now_ms: receipt.observed_at,
      evidence_retrievable: context.evidence_retrievable,
      human_attestation_verified: false,
    },
  );
}

/** Builds the deterministic history row for a changed axis. */
export function deriveDeliveryHistory(
  record: DeliveryRecord,
  eventId: string,
  noteCode: DeliveryHistoryNoteCode,
  at: number,
  evidenceRef: DeliveryRecord["content_ref"] | null,
): DeliveryHistoryEntry {
  return {
    delivery_id: record.delivery_id,
    event_id: eventId,
    at,
    state: record.state,
    inclusion_evidence: record.inclusion_evidence,
    adoption: record.adoption,
    evidence_ref: evidenceRef,
    terminal_reason: record.terminal_reason,
    note_code: noteCode,
  };
}

function applyTransport(
  record: DeliveryRecord,
  update: Extract<DeliveryUpdateRequest["update"], { axis: "transport" }>,
  nowMs: number,
): Result<DeliveryUpdateOutcome, ErrorEnvelope> {
  if (update.state === "submitted") {
    const submissionRef = update.submission_ref;
    if (typeof submissionRef !== "string" || submissionRef.length === 0) {
      return err(deliverySchemaError("submission_ref", "non_empty_string"));
    }
    if (record.state === "submitted" && record.submission_ref === submissionRef) {
      return ok(unchanged(record));
    }
    if (record.state !== "pending") {
      return err(deliverySchemaError("state", "pending_before_submitted"));
    }
    return ok({
      record: {
        ...record,
        state: "submitted",
        submission_ref: submissionRef,
        updated_at: nowMs,
        row_version: record.row_version + 1,
      },
      changed: true,
      history_only: false,
      note_code: "submitted",
      evidence_ref: null,
    });
  }
  const terminalState = update.state;
  const terminalReason: DeliveryTerminalReason = update.reason_code;
  if (
    record.state === terminalState &&
    record.terminal_reason === terminalReason
  ) {
    return ok(unchanged(record));
  }
  if (record.state !== "pending" && record.state !== "submitted") {
    return err(deliverySchemaError("state", "terminal_not_reentered"));
  }
  return ok({
    record: {
      ...record,
      state: terminalState,
      terminal_reason: terminalReason,
      updated_at: nowMs,
      row_version: record.row_version + 1,
    },
    changed: true,
    history_only: false,
    note_code: terminalState === "failed" ? "failed" : "expired",
    evidence_ref: null,
  });
}

function applyInclusion(
  record: DeliveryRecord,
  evidence: InclusionEvidence,
  evidenceRef: DeliveryRecord["content_ref"],
  requestVerified: boolean,
  nowMs: number,
): Result<DeliveryUpdateOutcome, ErrorEnvelope> {
  const currentRank = INCLUSION_EVIDENCE_RANK[record.inclusion_evidence];
  const newRank = INCLUSION_EVIDENCE_RANK[evidence];
  const verified = record.transport_body_verified || requestVerified;
  if (requestVerified && newRank < INCLUSION_EVIDENCE_RANK.transport_body) {
    return err(
      deliverySchemaError("transport_body_verified", "transport_body_or_host_confirmed"),
    );
  }
  if (newRank < currentRank) {
    return ok(unchanged(record));
  }
  if (newRank === currentRank && record.inclusion_ref === evidenceRef && verified === record.transport_body_verified) {
    return ok(unchanged(record));
  }
  if (verified && newRank < INCLUSION_EVIDENCE_RANK.transport_body) {
    return err(deliverySchemaError("inclusion_evidence", "transport_body_verified_requires_level"));
  }
  return ok({
    record: {
      ...record,
      inclusion_evidence: newRank > currentRank ? evidence : record.inclusion_evidence,
      inclusion_ref: evidenceRef,
      transport_body_verified: verified,
      updated_at: nowMs,
      row_version: record.row_version + 1,
    },
    changed: true,
    history_only: false,
    note_code: "inclusion_evidence",
    evidence_ref: evidenceRef,
  });
}

function applyAdoption(
  record: DeliveryRecord,
  adoption: AdoptionEvidence,
  evidenceRef: DeliveryRecord["content_ref"],
  verifier: DeliveryAdoptionVerifier | null,
  context: DeliveryUpdateContext,
): Result<DeliveryUpdateOutcome, ErrorEnvelope> {
  const currentRank = ADOPTION_EVIDENCE_RANK[record.adoption];
  const newRank = ADOPTION_EVIDENCE_RANK[adoption];
  if (newRank < currentRank) {
    return ok(unchanged(record));
  }
  if (newRank === currentRank && record.adoption_ref === evidenceRef) {
    return ok(unchanged(record));
  }
  if (adoption === "verified") {
    if (verifier === null) {
      return err(deliverySchemaError("verifier", "verified_needs_independent_verifier"));
    }
    if (verifier === "human" && !context.human_attestation_verified) {
      return err(deliverySchemaError("verifier", "human_attestation_verified"));
    }
  }
  return ok({
    record: {
      ...record,
      adoption: newRank > currentRank ? adoption : record.adoption,
      adoption_ref: evidenceRef,
      updated_at: context.now_ms,
      row_version: record.row_version + 1,
    },
    changed: true,
    history_only: false,
    note_code: "adoption_evidence",
    evidence_ref: evidenceRef,
  });
}

function inclusionFromReceipt(kind: DeliveryReceiptEvidenceKind): InclusionEvidence | null {
  switch (kind) {
    case "context_projection_seen":
      return "context_projection";
    case "provider_payload_captured":
      return "provider_payload";
    case "transport_body_captured":
      return "transport_body";
    case "host_confirmed":
      return "host_confirmed";
    default:
      return null;
  }
}

function adoptionFromReceipt(kind: DeliveryReceiptEvidenceKind): AdoptionEvidence | null {
  switch (kind) {
    case "behavior_observed":
      return "observed";
    case "independent_verifier":
      return "verified";
    default:
      return null;
  }
}

function unchanged(record: DeliveryRecord): DeliveryUpdateOutcome {
  return {
    record,
    changed: false,
    history_only: false,
    note_code: null,
    evidence_ref: null,
  };
}

function checkUpdateFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): ErrorEnvelope | null {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return deliverySchemaError(`update.${key}`, "known_field");
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return deliverySchemaError(`update.${field}`, "required");
    }
  }
  return null;
}

function parseEvidenceRef(value: unknown): Result<SourceRef, ErrorEnvelope> {
  if (typeof value !== "string") {
    return err(deliverySchemaError("evidence_ref", "source_ref"));
  }
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(parsed.value.source_ref);
}

/** True when the inclusion update is legal against the current row. */
export function isInclusionEvidenceMonotone(
  current: InclusionEvidence,
  next: InclusionEvidence,
): boolean {
  return INCLUSION_EVIDENCE_RANK[next] >= INCLUSION_EVIDENCE_RANK[current];
}

/** True when the adoption update is legal against the current row. */
export function isAdoptionEvidenceMonotone(
  current: AdoptionEvidence,
  next: AdoptionEvidence,
): boolean {
  return ADOPTION_EVIDENCE_RANK[next] >= ADOPTION_EVIDENCE_RANK[current];
}

/** True when the row has passed its wall-clock expiry. */
export function isDeliveryExpired(record: DeliveryRecord, nowMs: number): boolean {
  return record.expires_at <= nowMs && !isDeliveryTerminal(record.state);
}

/** Type guard used before applying a caller-supplied inclusion value. */
export function parseInclusionEvidence(value: string): InclusionEvidence | null {
  return isInclusionEvidence(value) ? value : null;
}

/** Type guard used before applying a caller-supplied adoption value. */
export function parseAdoptionEvidence(value: string): AdoptionEvidence | null {
  return isAdoptionEvidence(value) ? value : null;
}
