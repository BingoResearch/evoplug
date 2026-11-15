/**
 * Delivery plan/record, three evidence axes and history shapes
 * (DD-FND-092, DD-FND-097.4).
 *
 * The design's `DeliveryPlan` deliberately has no `watermark` field; the
 * DD-FND-057 DDL column is older than the DD-FND-092 row shape and is not
 * added here. Every array is kept in the design order and no axis is
 * collapsed into another.
 */

import type { Hash, Id, SourceRef } from "@evoplug/core";

export type DeliveryState = "pending" | "submitted" | "expired" | "failed";

export type DeliveryTerminalReason =
  | "host_rejected"
  | "version_changed"
  | "timeout"
  | "cancelled"
  | "expired_by_time";

export type InclusionEvidence =
  | "unknown"
  | "context_projection"
  | "provider_payload"
  | "transport_body"
  | "host_confirmed";

export type AdoptionEvidence = "unknown" | "observed" | "verified";

export type DeliveryAdoptionVerifier =
  | "human"
  | "independent_artifact"
  | "independent_verifier";

export interface DeliveryPlan {
  schema_version: "rsi.delivery_plan/1";
  task_id: Id<"task">;
  branch_id: Id<"br">;
  input_epoch: number;
  config_version: string;
  goal_version: string;
  /** UTF-8 ascending, unique; may be empty only when `issue_id` is non-null. */
  requirement_ids: Id<"req">[];
  issue_id: Id<"issue"> | null;
  evidence_hash: Hash;
  pack_hash: Hash;
  content_hash: Hash;
  content_ref: SourceRef;
  expires_at: number;
}

export interface DeliveryRecord extends Omit<DeliveryPlan, "schema_version"> {
  schema_version: "rsi.delivery/2";
  delivery_id: Id<"del">;
  dedupe_key: Hash;
  state: DeliveryState;
  terminal_reason: DeliveryTerminalReason | null;
  inclusion_evidence: InclusionEvidence;
  transport_body_verified: boolean;
  submission_ref: string | null;
  inclusion_ref: SourceRef | null;
  adoption: AdoptionEvidence;
  adoption_ref: SourceRef | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

export type DeliveryUpdateRequest =
  | {
      schema_version: "rsi.delivery_update/1";
      delivery_id: Id<"del">;
      expected_row_version: number;
      update: { axis: "transport"; state: "submitted"; submission_ref: string };
    }
  | {
      schema_version: "rsi.delivery_update/1";
      delivery_id: Id<"del">;
      expected_row_version: number;
      update: {
        axis: "transport";
        state: "failed" | "expired";
        reason_code: "host_rejected" | "version_changed" | "timeout" | "cancelled";
      };
    }
  | {
      schema_version: "rsi.delivery_update/1";
      delivery_id: Id<"del">;
      expected_row_version: number;
      update: {
        axis: "inclusion";
        evidence: InclusionEvidence;
        evidence_ref: SourceRef;
        transport_body_verified: boolean;
      };
    }
  | {
      schema_version: "rsi.delivery_update/1";
      delivery_id: Id<"del">;
      expected_row_version: number;
      update: {
        axis: "adoption";
        adoption: AdoptionEvidence;
        evidence_ref: SourceRef;
        verifier: DeliveryAdoptionVerifier | null;
      };
    };

export type DeliveryHistoryNoteCode =
  | "created"
  | "submitted"
  | "failed"
  | "expired"
  | "late_ack"
  | "inclusion_evidence"
  | "adoption_evidence";

export interface DeliveryHistoryEntry {
  delivery_id: Id<"del">;
  /** Ledger event id or host event id; stable rebuild identity. */
  event_id: string;
  at: number;
  state: DeliveryState;
  inclusion_evidence: InclusionEvidence;
  adoption: AdoptionEvidence;
  evidence_ref: SourceRef | null;
  terminal_reason: DeliveryTerminalReason | null;
  note_code: DeliveryHistoryNoteCode;
}

/** Result of one axis update; `history_only` appends without touching the row. */
export interface DeliveryUpdateOutcome {
  record: DeliveryRecord;
  changed: boolean;
  history_only: boolean;
  note_code: DeliveryHistoryNoteCode | null;
  evidence_ref: SourceRef | null;
}

export const DELIVERY_PLAN_SCHEMA_VERSION: "rsi.delivery_plan/1" = "rsi.delivery_plan/1";

export const DELIVERY_RECORD_SCHEMA_VERSION: "rsi.delivery/2" = "rsi.delivery/2";

export const DELIVERY_UPDATE_SCHEMA_VERSION: "rsi.delivery_update/1" =
  "rsi.delivery_update/1";

/** Inclusion axis is strictly monotone in this order. */
export const INCLUSION_EVIDENCE_RANK: Readonly<Record<InclusionEvidence, number>> = {
  unknown: 0,
  context_projection: 1,
  provider_payload: 2,
  transport_body: 3,
  host_confirmed: 4
};

/** Adoption axis is independently monotone. */
export const ADOPTION_EVIDENCE_RANK: Readonly<Record<AdoptionEvidence, number>> = {
  unknown: 0,
  observed: 1,
  verified: 2
};

export function isDeliveryState(value: string): value is DeliveryState {
  return (
    value === "pending" || value === "submitted" || value === "expired" || value === "failed"
  );
}

export function isDeliveryTerminalReason(value: string): value is DeliveryTerminalReason {
  switch (value) {
    case "host_rejected":
    case "version_changed":
    case "timeout":
    case "cancelled":
    case "expired_by_time":
      return true;
    default:
      return false;
  }
}

export function isInclusionEvidence(value: string): value is InclusionEvidence {
  switch (value) {
    case "unknown":
    case "context_projection":
    case "provider_payload":
    case "transport_body":
    case "host_confirmed":
      return true;
    default:
      return false;
  }
}

export function isAdoptionEvidence(value: string): value is AdoptionEvidence {
  return value === "unknown" || value === "observed" || value === "verified";
}

export function isDeliveryTerminal(state: DeliveryState): boolean {
  return state === "expired" || state === "failed";
}
