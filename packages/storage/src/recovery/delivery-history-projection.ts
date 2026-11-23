/**
 * Journal-only projection of `delivery_history` (DD-FND-097.4, W5).
 *
 * The delivery row is the current state; `delivery_history` is the append-only
 * sequence of state changes. A rebuild must restore both. Transition frames
 * carry the frozen history row under `event.history`; create frames from older
 * journals are recovered from the insert event's row image.
 */

import { type ErrorEnvelope, type JsonValue, canonicalJsonText } from "@evoplug/core";

import { storageError, internalDetails } from "../errors.js";
import type { StatementSource } from "../types.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return sharedIsRecord(value);
}

interface HistoryRow {
  readonly delivery_id: string;
  readonly event_id: string;
  readonly at: number;
  readonly state: string;
  readonly inclusion_evidence: string;
  readonly adoption: string;
  readonly evidence_ref: string | null;
  readonly terminal_reason: string | null;
  readonly note_code: string;
}

const STATES = new Set(["pending", "submitted", "expired", "failed"]);
const INCLUSION = new Set([
  "unknown",
  "context_projection",
  "provider_payload",
  "transport_body",
  "host_confirmed"
]);
const ADOPTION = new Set(["unknown", "observed", "verified"]);
const TERMINAL_REASONS = new Set([
  "host_rejected",
  "version_changed",
  "timeout",
  "cancelled",
  "expired_by_time"
]);
const NOTE_CODES = new Set([
  "created",
  "submitted",
  "failed",
  "expired",
  "late_ack",
  "inclusion_evidence",
  "adoption_evidence"
]);

function divergence(detail: string): ErrorEnvelope {
  return storageError({
    code: "E_REBUILD_DIVERGENCE",
    stage: "storage.delivery_history_rebuild",
    details: internalDetails(detail),
    message_key: "error.storage.rebuild_divergence"
  });
}

/** Appendix F.6: name the table and key on a non-idempotent replay. */
function keyDivergence(
  key: Record<string, JsonValue>,
  detail: string
): ErrorEnvelope {
  return divergence(
    `state_row_conflict:table=delivery_history;key=${canonicalJsonText(key as JsonValue)};detail=${detail}`
  );
}

function stringOrNull(value: JsonValue | undefined): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function historyFromPayload(
  event: Record<string, JsonValue>
): HistoryRow | null | "invalid" {
  const history = event["history"];
  if (isRecord(history)) {
    const deliveryId = event["entity_id"];
    const eventId = event["event_id"];
    const at = history["at"];
    const state = history["state"];
    const inclusion = history["inclusion_evidence"];
    const adoption = history["adoption"];
    const evidenceRef = stringOrNull(history["evidence_ref"]);
    const terminalReason = stringOrNull(history["terminal_reason"]);
    const noteCode = history["note_code"];
    if (
      typeof deliveryId !== "string" ||
      typeof eventId !== "string" ||
      typeof at !== "number" ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      typeof state !== "string" ||
      !STATES.has(state) ||
      typeof inclusion !== "string" ||
      !INCLUSION.has(inclusion) ||
      typeof adoption !== "string" ||
      !ADOPTION.has(adoption) ||
      evidenceRef === undefined ||
      terminalReason === undefined ||
      (terminalReason !== null && !TERMINAL_REASONS.has(terminalReason)) ||
      typeof noteCode !== "string" ||
      !NOTE_CODES.has(noteCode)
    ) {
      return "invalid";
    }
    return {
      delivery_id: deliveryId,
      event_id: eventId,
      at,
      state,
      inclusion_evidence: inclusion,
      adoption,
      evidence_ref: evidenceRef,
      terminal_reason: terminalReason,
      note_code: noteCode
    };
  }
  // Create frames in journals written before the frozen history field are
  // recovered from the insert row image. A transition carries information that
  // the final row cannot reconstruct (which axis changed, late ack); without
  // the frozen history the rebuild must fail closed rather than guess.
  const operation = event["operation"];
  if (operation === "transition") {
    return "invalid";
  }
  if (operation !== "insert") {
    return null;
  }
  const deliveryId = event["entity_id"];
  const eventId = event["event_id"];
  const recordedAt = event["recorded_at"];
  const rowJson = event["row_json"];
  if (
    typeof deliveryId !== "string" ||
    typeof eventId !== "string" ||
    typeof recordedAt !== "number" ||
    !Number.isSafeInteger(recordedAt) ||
    typeof rowJson !== "string"
  ) {
    return "invalid";
  }
  let row: unknown;
  try {
    row = JSON.parse(rowJson);
  } catch {
    return "invalid";
  }
  if (!isRecord(row) || row["state"] !== "pending") {
    return null;
  }
  const contentRef = stringOrNull(row["content_ref"]);
  if (contentRef === undefined) {
    return "invalid";
  }
  return {
    delivery_id: deliveryId,
    event_id: eventId,
    at: recordedAt,
    state: "pending",
    inclusion_evidence: "unknown",
    adoption: "unknown",
    evidence_ref: contentRef,
    terminal_reason: null,
    note_code: "created"
  };
}

/**
 * Projects one ledger event, if it is a delivery event that carries history.
 * Returns `projected: false` for unrelated or idempotently replayed events.
 */
export function projectDeliveryHistoryEvent(
  source: StatementSource,
  event: JsonValue
): { readonly ok: true; readonly value: { readonly projected: boolean } } | { readonly ok: false; readonly error: ErrorEnvelope } {
  if (!isRecord(event)) {
    return { ok: true, value: { projected: false } };
  }
  if (event["event_type"] !== "delivery.recorded" || event["entity_type"] !== "delivery") {
    return { ok: true, value: { projected: false } };
  }
  const history = historyFromPayload(event);
  if (history === "invalid") {
    return { ok: false, error: divergence("delivery_history_payload_invalid") };
  }
  if (history === null) {
    return { ok: true, value: { projected: false } };
  }
  const existing = source
    .prepare<{ history_id: number; state: string; inclusion_evidence: string; adoption: string; evidence_ref: string | null; terminal_reason: string | null; note_code: string; at: number }>(
      "SELECT history_id, at, state, inclusion_evidence, adoption, evidence_ref, terminal_reason, note_code FROM delivery_history WHERE delivery_id = :delivery_id AND event_id = :event_id"
    )
    .get({ delivery_id: history.delivery_id, event_id: history.event_id });
  if (existing !== undefined) {
    // Same (delivery_id, event_id) with the frozen content is an idempotent
    // replay. Different content at the same unique key means the projection
    // and the journal disagree; fail closed and name both.
    const same =
      Number(existing.at) === history.at &&
      String(existing.state) === history.state &&
      String(existing.inclusion_evidence) === history.inclusion_evidence &&
      String(existing.adoption) === history.adoption &&
      existing.evidence_ref === history.evidence_ref &&
      existing.terminal_reason === history.terminal_reason &&
      String(existing.note_code) === history.note_code;
    if (same) {
      return { ok: true, value: { projected: false } };
    }
    return {
      ok: false,
      error: keyDivergence(
        { delivery_id: history.delivery_id, event_id: history.event_id },
        "history_content_mismatch"
      )
    };
  }
  const parent = source
    .prepare<{ delivery_id: string }>(
      "SELECT delivery_id FROM delivery WHERE delivery_id = :delivery_id"
    )
    .get({ delivery_id: history.delivery_id });
  if (parent === undefined) {
    return { ok: false, error: divergence("delivery_history_parent_missing") };
  }
  source
    .prepare(
      `INSERT INTO delivery_history (
         delivery_id, event_id, at, state, inclusion_evidence, adoption,
         evidence_ref, terminal_reason, note_code
       ) VALUES (
         :delivery_id, :event_id, :at, :state, :inclusion_evidence, :adoption,
         :evidence_ref, :terminal_reason, :note_code
       )`
    )
    .run({
      delivery_id: history.delivery_id,
      event_id: history.event_id,
      at: history.at,
      state: history.state,
      inclusion_evidence: history.inclusion_evidence,
      adoption: history.adoption,
      evidence_ref: history.evidence_ref,
      terminal_reason: history.terminal_reason,
      note_code: history.note_code
    });
  return { ok: true, value: { projected: true } };
}
