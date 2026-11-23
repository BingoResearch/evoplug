import type {
  ErrorEnvelope,
  Hash,
  HostId,
  Id,
  JsonValue,
  Result,
  SourceRef,
  SourceRefPort,
  VersionBinding,
} from "@evoplug/core";
import type { HumanAttestation, Origin, TriggerLineage } from "./domain/common.js";
import type {
  ForkIdempotencyRecord,
  NativeSessionMapping,
} from "./domain/identity.js";
import type {
  FactVerificationStateRow,
  FeedbackStateRow,
  GoalSnapshotStateRow,
  LedgerCorrectionStateRow,
  RequirementHeadStateRow,
  RequirementOpStateRow,
  RequirementSourceStateRow,
  RequirementStateRow,
  StateFactStateRow,
  SuccessEvidenceStateRow,
  TaskOutcomeStateRow,
  UnverifiedConstraintStateRow,
} from "./rows.js";

/* ------------------------------------------------------------------ */
/* Clock and source ports                                              */
/* ------------------------------------------------------------------ */

export interface LedgerClockPort {
  now(): number;
}

export type HumanProofVerdict = "verified" | "unverified" | "conflict";

export type HumanProofPurpose =
  | "replay_approve"
  | "replay_revoke"
  | "replay_reject"
  | "replay_reconcile"
  | "egress_approve"
  | "grant_issue"
  | "grant_revoke"
  | "adapter_install";

/**
 * Implemented by HOST with verified capabilities; FND only consumes
 * `verified` and never fabricates a human origin.
 */
export interface OriginProofPort {
  verifyHuman(input: {
    readonly attestation: HumanAttestation;
    readonly host_id: HostId;
    readonly config_space: string;
    readonly native_session_id: string;
    readonly event_key: Hash;
  }): Promise<HumanProofVerdict>;
  verifyControlPlane(input: {
    readonly attestation: HumanAttestation;
    readonly subject_hash: Hash;
    readonly purpose: HumanProofPurpose;
  }): Promise<HumanProofVerdict>;
}

/* ------------------------------------------------------------------ */
/* State-row write port                                                */
/* ------------------------------------------------------------------ */

export type LedgerStateRowSchema =
  | "rsi.requirement_op_row/1"
  | "rsi.requirement_row/1"
  | "rsi.requirement_source_row/1"
  | "rsi.requirement_head_row/1"
  | "rsi.goal_snapshot_row/1"
  | "rsi.ledger_correction_row/1"
  | "rsi.state_fact_row/1"
  | "rsi.fact_verification_row/1"
  | "rsi.feedback_row/1"
  | "rsi.unverified_constraint_row/1"
  | "rsi.success_evidence_row/1"
  | "rsi.task_outcome_row/1";

export type LedgerStateRowOperation = "insert" | "update" | "transition";

export interface LedgerStateRowWrite {
  readonly row_schema: LedgerStateRowSchema;
  readonly operation: LedgerStateRowOperation;
  /**
   * Complete after-image row JSON, using physical column names. Typed row
   * objects are serialized by the ledger and validated by the state-row
   * registry in the storage port.
   */
  readonly row: JsonValue;
  readonly document_id: Hash | null;
}

export interface LedgerAppendRequest {
  /** `null` only for an all-global batch; ledger rows are always bound. */
  readonly binding: VersionBinding | null;
  readonly rows: readonly LedgerStateRowWrite[];
}

export interface LedgerAppendReceipt {
  readonly batch_hash: Hash;
  readonly first_commit_seq: number;
  readonly last_commit_seq: number;
}

export type LedgerCommitOutcome =
  | { readonly ok: true; readonly commit_state: "committed"; readonly receipt: LedgerAppendReceipt }
  | { readonly ok: true; readonly commit_state: "existing" }
  | {
      readonly ok: false;
      readonly commit_state: "not_written" | "unknown_recovery_required";
      readonly error: ErrorEnvelope;
    };

/**
 * Subset of the FND `StateRowPort` that the ledger needs. The storage package
 * owns the concrete implementation and the generated row types; the ledger
 * serializes complete after-image rows and never writes SQL directly.
 */
export interface LedgerStateRowPort {
  appendStateRows(input: LedgerAppendRequest): Promise<LedgerCommitOutcome>;
}

/**
 * Blob write face used to freeze requirement statement text before the state
 * row batch. The storage package owns content-addressed writes; the ledger
 * only asks for the frozen reference and hash.
 */
export interface LedgerStoredText {
  readonly source_ref: SourceRef;
  readonly content_hash: Hash;
  readonly byte_length: number;
}

export interface LedgerBlobWritePort {
  putText(text: string): Promise<Result<LedgerStoredText, ErrorEnvelope>>;
}

export interface LedgerStateRowKey {
  readonly row_schema: LedgerStateRowSchema;
  readonly key: { readonly [column: string]: JsonValue };
}

export interface LedgerStateRowSnapshot {
  readonly row_schema: LedgerStateRowSchema;
  readonly row: JsonValue;
  readonly commit_seq: number;
}

export interface LedgerStateRowReadQuery {
  readonly row_schemas: readonly LedgerStateRowSchema[];
  readonly binding: VersionBinding | null;
  readonly keys: readonly LedgerStateRowKey[];
}

/** Exact-key, single-snapshot read face. */
export interface LedgerStateRowReadPort {
  readStateRows(
    q: LedgerStateRowReadQuery,
  ): Promise<Result<readonly LedgerStateRowSnapshot[], ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Event log and identity ports                                        */
/* ------------------------------------------------------------------ */

export interface LedgerSourceEvent {
  readonly event_id: Id<"ev">;
  readonly event_key: Hash;
  readonly event_type: string;
  readonly host_id: HostId;
  readonly config_space: string;
  readonly session_id: Id<"sess">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly input_id: Id<"input"> | null;
  readonly input_epoch: number | null;
  readonly goal_version: string;
  readonly config_version: string;
  readonly watermark: number;
  readonly origin: Origin;
  readonly human_attestation: HumanAttestation | null;
  /** Native session ID of the event's session, when the join is available. */
  readonly native_session_id: string | null;
  readonly directive_strength: "explicit" | "ambiguous" | null;
  readonly trigger_lineage: TriggerLineage;
  readonly correlation_id: Id<"corr">;
}

export interface LedgerEventLogPort {
  getEvent(eventId: Id<"ev">): Promise<Result<LedgerSourceEvent | null, ErrorEnvelope>>;
}

export interface LedgerSessionView {
  readonly session_id: Id<"sess">;
  readonly host_id: HostId;
  readonly config_space: string;
  readonly native_session_id: string | null;
  readonly current_branch_id: Id<"br"> | null;
  readonly resume_generation: number;
}

export interface LedgerBranchView {
  readonly branch_id: Id<"br">;
  readonly task_id: Id<"task">;
  readonly parent_branch_id: Id<"br"> | null;
  readonly forked_from_watermark: number | null;
  readonly inherited_goal_snapshot_id: Id<"gsnap"> | null;
  readonly current_goal_version: string;
  readonly current_goal_revision: number;
  readonly current_goal_snapshot_id: Id<"gsnap"> | null;
  /** Highest admitted input epoch on the branch. */
  readonly current_input_epoch: number;
  /** Active config version for the branch's config space. */
  readonly current_config_version: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface LedgerIdentityReadPort {
  getSession(sessionId: Id<"sess">): Promise<Result<LedgerSessionView | null, ErrorEnvelope>>;
  findSession(q: {
    readonly host_id: HostId;
    readonly config_space: string;
    readonly native_session_id: string;
  }): Promise<Result<LedgerSessionView | null, ErrorEnvelope>>;
  listNativeMappings(q: {
    readonly host_id: HostId;
    readonly config_space: string;
    readonly native_session_id: string;
  }): Promise<Result<readonly NativeSessionMapping[], ErrorEnvelope>>;
  getBranch(branchId: Id<"br">): Promise<Result<LedgerBranchView | null, ErrorEnvelope>>;
  getReceiptSeq(): Promise<Result<number, ErrorEnvelope>>;
  findForkIdempotency(q: {
    readonly source_branch_id: Id<"br">;
    readonly at_watermark: number;
    readonly reason: "explicit_request";
    readonly idempotency_key: Hash;
  }): Promise<Result<ForkIdempotencyRecord | null, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Ledger projection read ports                                        */
/* ------------------------------------------------------------------ */

export interface LedgerRequirementReadQuery {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly watermark: number;
}

export interface LedgerGoalSnapshotQuery {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly goal_version: string;
  /** Inclusive upper bound on snapshot watermark. */
  readonly watermark_max: number;
}

/**
 * Read side used by as-of projection and view assembly. Implementations run
 * inside one `BEGIN DEFERRED` snapshot and never repair or refresh rows.
 */
export interface LedgerProjectionReadPort {
  listRequirementRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly RequirementStateRow[], ErrorEnvelope>>;
  listRequirementOpRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly RequirementOpStateRow[], ErrorEnvelope>>;
  listRequirementSources(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly RequirementSourceStateRow[], ErrorEnvelope>>;
  listRequirementHeads(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly RequirementHeadStateRow[], ErrorEnvelope>>;
  listGoalSnapshots(
    q: LedgerGoalSnapshotQuery,
  ): Promise<Result<readonly GoalSnapshotStateRow[], ErrorEnvelope>>;
  listFeedbackRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly FeedbackStateRow[], ErrorEnvelope>>;
  listConstraintRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly UnverifiedConstraintStateRow[], ErrorEnvelope>>;
  listCorrectionRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly LedgerCorrectionStateRow[], ErrorEnvelope>>;
  listFactRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly StateFactStateRow[], ErrorEnvelope>>;
  listFactVerificationRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly FactVerificationStateRow[], ErrorEnvelope>>;
  listSuccessEvidenceRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly SuccessEvidenceStateRow[], ErrorEnvelope>>;
  listTaskOutcomeRows(
    q: LedgerRequirementReadQuery,
  ): Promise<Result<readonly TaskOutcomeStateRow[], ErrorEnvelope>>;
}

/** Budget reservation facts needed by `verifyFact`; no cost arithmetic here. */
export interface LedgerReservationView {
  readonly reservation_id: Id<"resv">;
  readonly binding: VersionBinding;
  readonly purpose: "verifier" | "review" | "delivery" | "other";
  readonly status: "reserved" | "claimed" | "settled" | "released" | "expired" | "unsettled";
}

export interface LedgerReservationReadPort {
  getReservation(id: Id<"resv">): Promise<Result<LedgerReservationView | null, ErrorEnvelope>>;
}

/**
 * Atomic verification commit: event-log member, `state_fact` update and
 * `fact_verification` insert in one cross-binding batch (DD-FND-059.1.3).
 * The storage package owns event assembly; the ledger supplies the frozen
 * payload and both after-images.
 */
export interface VerificationCommitInput {
  readonly binding: VersionBinding;
  readonly payload: import("./domain/facts.js").FactVerificationRecordedPayloadV2;
  readonly state_fact_after: JsonValue;
  readonly fact_verification_row: JsonValue;
  readonly fact_id: Id<"fact">;
  readonly verifier_ref: SourceRef;
  readonly event_id: Id<"ev">;
  readonly trigger_event_id: Id<"ev">;
}

export interface LedgerVerificationCommitPort {
  commitVerification(input: VerificationCommitInput): Promise<LedgerCommitOutcome>;
}

export interface LedgerPorts {
  readonly store: LedgerStateRowPort;
  readonly stateRows: LedgerStateRowReadPort;
  readonly blobs: LedgerBlobWritePort;
  readonly events: LedgerEventLogPort;
  readonly identity: LedgerIdentityReadPort;
  readonly projection: LedgerProjectionReadPort;
  readonly verificationCommit: LedgerVerificationCommitPort;
  readonly reservations: LedgerReservationReadPort;
  readonly sources: SourceRefPort;
  readonly proof: OriginProofPort;
  readonly clock: LedgerClockPort;
}
