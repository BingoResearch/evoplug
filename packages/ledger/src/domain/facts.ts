import type { ContentKey, Hash, Id, SourceRef, VersionBinding } from "@evoplug/core";
import type { MethodRef } from "@evoplug/core";

export type StateFactKind =
  | "code"
  | "interface_contract"
  | "call"
  | "result"
  | "diff"
  | "test"
  | "message";

export interface StateFactDraft {
  readonly schema_version: "rsi.state_fact_draft/1";
  readonly binding: VersionBinding;
  readonly kind: StateFactKind;
  readonly subject: string;
  readonly value: string;
  readonly truth_state: "claim" | "observed";
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly artifact_version: string | null;
  readonly observed_at: number;
}

export type VerifierKind = "test" | "artifact_check" | "external" | "human";
export type VerifierResult = "verified" | "contradicted" | "unknown";
export type FactVerificationEffect = "supports" | "violates" | "unknown";
export type FactVerificationStatus = "valid" | "invalidated" | "unknown";

export interface VerifyFactRequest {
  readonly schema_version: "rsi.verify_fact/1";
  readonly fact_id: Id<"fact">;
  /** Verification event session; must already be bound to the branch. */
  readonly session_id: Id<"sess">;
  /** Committed event that triggered this verification. */
  readonly trigger_event_id: Id<"ev">;
  readonly expected_row_version: number;
  readonly binding: VersionBinding;
  readonly verifier_ref: SourceRef;
  readonly verifier_id: string;
  readonly verifier_kind: VerifierKind;
  /** Method and rule version that produced the result; required for new writes. */
  readonly method_ref: MethodRef;
  /** UTF-8 sorted, de-duplicated; `[]` when no local paid call was made. */
  readonly reservation_ids: Id<"resv">[];
  readonly requirement_ids: Id<"req">[];
  readonly proposition_ids: ContentKey<"propo">[];
  readonly effect: FactVerificationEffect;
  readonly artifact_version: string | null;
  readonly source_ids: string[];
  readonly source_refs: SourceRef[];
  readonly result: VerifierResult;
}

export interface VerifierRegistryView {
  readonly schema_version: "rsi.fact_verification/1";
  readonly fact_id: Id<"fact">;
  readonly event_id: Id<"ev">;
  readonly verifier_ref: SourceRef;
  readonly verifier_id: string;
  readonly verifier_kind: VerifierKind;
  /** `null` only for legacy `/1` rows. */
  readonly method_ref: MethodRef | null;
  readonly reservation_ids: readonly Id<"resv">[];
  /** `verifier_ref !== fact.producer_ref`; evidence identity only. */
  readonly independent: boolean;
  readonly verification_binding: VersionBinding;
  readonly requirement_ids: Id<"req">[];
  readonly proposition_ids: ContentKey<"propo">[];
  readonly effect: FactVerificationEffect;
  readonly artifact_version: string | null;
  readonly source_ids: string[];
  readonly source_refs: SourceRef[];
  readonly result: VerifierResult;
  readonly status: FactVerificationStatus;
  readonly verified_at: number;
  readonly row_version: number;
}

export interface StateFactView {
  readonly schema_version: "rsi.state_fact/1";
  readonly fact_id: Id<"fact">;
  readonly binding: VersionBinding;
  readonly kind: StateFactKind;
  readonly subject: string;
  readonly value: string;
  readonly truth_state: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  readonly stale: boolean;
  readonly stale_reason: "artifact_changed" | "verifier_invalidated" | "correction" | "explicit" | null;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  /** Most recent `valid` verifier reference. */
  readonly verifier_ref: SourceRef | null;
  readonly artifact_version: string | null;
  readonly observed_at: number;
  /** Sorted by `verifier_ref` UTF-8 order; includes invalidated records. */
  readonly verifiers: VerifierRegistryView[];
  readonly row_version: number;
}

export interface FactListQuery {
  readonly binding: VersionBinding;
  readonly fact_ids?: readonly Id<"fact">[];
  readonly kinds?: readonly StateFactKind[];
  readonly truth_states?: readonly StateFactView["truth_state"][];
}

export interface FactReadPort {
  listFacts(q: FactListQuery): Promise<readonly StateFactView[]>;
  getFact(q: { readonly fact_id: Id<"fact">; readonly binding: VersionBinding }): Promise<StateFactView | null>;
}

export interface VerifierListQuery {
  readonly binding: VersionBinding;
  readonly fact_id?: Id<"fact">;
  readonly requirement_id?: Id<"req">;
  readonly statuses?: readonly FactVerificationStatus[];
}

export interface VerifierRegistryPort {
  getVerifier(q: {
    readonly fact_id: Id<"fact">;
    readonly verifier_ref: SourceRef;
    readonly binding: VersionBinding;
  }): Promise<VerifierRegistryView | null>;
  listVerifiers(q: VerifierListQuery): Promise<readonly VerifierRegistryView[]>;
}

/** Current `/2` verification payload (DD-FND-070, DD-FND-074). */
export interface FactVerificationRecordedPayloadV2 {
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

/** Legacy read-only `/1` payload; missing fields are mapped, never backfilled. */
export interface FactVerificationRecordedPayloadV1 {
  readonly schema_version: "rsi.fact_verification.recorded/1";
  readonly fact_id: Id<"fact">;
  readonly verification_binding: VersionBinding;
  readonly verifier_ref: SourceRef;
  readonly verifier_id: string;
  readonly verifier_kind: VerifierKind;
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

export type FactVerificationRecordedPayload =
  | FactVerificationRecordedPayloadV2
  | FactVerificationRecordedPayloadV1;

export const STATE_FACT_KINDS: readonly StateFactKind[] = [
  "code",
  "interface_contract",
  "call",
  "result",
  "diff",
  "test",
  "message",
];

export const VERIFIER_KINDS: readonly VerifierKind[] = [
  "test",
  "artifact_check",
  "external",
  "human",
];
