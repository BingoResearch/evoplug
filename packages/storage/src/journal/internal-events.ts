/**
 * Internal journal event vocabulary (DD-FND-070).
 *
 * FND writes one internal journal event that is not a host event: the fact
 * verification record. It is not a host `EventType`, does not pass through
 * `event.ingest` and is not a `LedgerEventType`; it never reaches
 * `ledger_event_log`. It is written to `event_log` and shares the
 * `commit_seq` of the two `state_row.recorded` members of its frame.
 *
 * The legacy payload shape below is read-only. A missing `method_ref` maps to
 * `null` and a missing `reservation_ids` maps to `[]`; neither is
 * fabricated.
 */

import type {
  ContentKey,
  Hash,
  Id,
  MethodRef,
  SourceRef,
  VersionBinding
} from "@evoplug/core";

export type InternalJournalEventType = "fact_verification.recorded";

/** The only member of {@link InternalJournalEventType}. */
export const INTERNAL_JOURNAL_EVENT_TYPES: readonly InternalJournalEventType[] = Object.freeze([
  "fact_verification.recorded"
] as const);

const INTERNAL_JOURNAL_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(
  INTERNAL_JOURNAL_EVENT_TYPES
);

/** True when `value` is a registered internal journal event type. */
export function isInternalJournalEventType(value: unknown): value is InternalJournalEventType {
  return typeof value === "string" && INTERNAL_JOURNAL_EVENT_TYPE_SET.has(value);
}

/** The verifier kinds a fact verification record may carry. */
export type VerifierKind = "test" | "artifact_check" | "external" | "human";

/** The outcome a fact verification record may carry. */
export type VerifierResult = "verified" | "contradicted" | "unknown";

/** The effect a fact verification record may carry. */
export type FactVerificationEffect = "supports" | "violates" | "unknown";

/** The lifecycle status a fact verification record may carry. */
export type FactVerificationStatus = "valid" | "invalidated" | "unknown";

/**
 * The current `/2` fact verification payload. New writes always use this
 * shape; the `/1` shape is read-only.
 */
export interface FactVerificationRecordedPayload {
  readonly schema_version: "rsi.fact_verification.recorded/2";
  readonly fact_id: Id<"fact">;
  readonly verification_binding: VersionBinding;
  readonly verifier_ref: SourceRef;
  readonly verifier_id: string;
  readonly verifier_kind: VerifierKind;
  readonly method_ref: MethodRef;
  readonly reservation_ids: readonly Id<"resv">[];
  readonly independent: boolean;
  readonly requirement_ids: readonly Id<"req">[];
  readonly proposition_ids: readonly ContentKey<"propo">[];
  readonly effect: FactVerificationEffect;
  readonly artifact_version: string | null;
  readonly source_ids: readonly string[];
  readonly source_refs: readonly SourceRef[];
  readonly result: VerifierResult;
  readonly status: FactVerificationStatus;
  readonly content_hash: Hash;
  readonly verified_at: number;
}

/**
 * The legacy `/1` payload. Read-only: a missing `method_ref` maps to `null`
 * and a missing `reservation_ids` maps to `[]`; neither is backfilled.
 */
export type LegacyFactVerificationRecordedPayload = Omit<
  FactVerificationRecordedPayload,
  "schema_version" | "method_ref" | "reservation_ids"
> & { schema_version: "rsi.fact_verification.recorded/1" };
