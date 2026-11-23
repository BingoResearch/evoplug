import type { ErrorEnvelope, Hash, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type { HumanAttestation, Origin, TaskOutcome } from "./common.js";
import type {
  FeedbackRecord,
  LedgerCorrection,
  LedgerFeedbackRow,
} from "./feedback.js";
import type {
  AcceptanceCriterion,
  CurrentRequirement,
  LedgerRequirementOpRow,
  LedgerRequirementRow,
  UnverifiedConstraint,
} from "./requirements.js";
import type { StateFactView } from "./facts.js";

export type SuccessEvidenceKind =
  | "human_acceptance"
  | "test_pass"
  | "artifact_check"
  | "external_verification";

export type SuccessEvidenceProducerKind =
  | "human"
  | "test_runner"
  | "artifact_checker"
  | "external_verifier";

export interface SuccessEvidence {
  readonly schema_version: "rsi.success_evidence/2";
  readonly evidence_id: Id<"sev">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly kind: SuccessEvidenceKind;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly producer_kind: SuccessEvidenceProducerKind;
  /** UTF-8 sorted; must cover the matching acceptance criterion. */
  readonly covered_requirement_ids: Id<"req">[];
  readonly binding: VersionBinding;
  readonly human_attestation: HumanAttestation | null;
  readonly attestation_subject_hash: Hash | null;
  readonly verified_at: number;
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
  readonly evidence_hash: Hash;
  readonly row_version: number;
}

export type SuccessEvidenceView = Omit<SuccessEvidence, "human_attestation">;

export interface RecordSuccessEvidenceRequest {
  readonly binding: VersionBinding;
  readonly kind: SuccessEvidenceKind;
  readonly source_event_id: Id<"ev">;
  readonly source_ref: SourceRef;
  readonly producer_ref: SourceRef;
  readonly producer_kind: SuccessEvidenceProducerKind;
  readonly covered_requirement_ids: Id<"req">[];
  readonly verified_at: number;
  readonly human_attestation: HumanAttestation | null;
}

export interface SuccessEvidencePort {
  recordSuccessEvidence(
    input: RecordSuccessEvidenceRequest,
  ): Promise<Result<SuccessEvidence, ErrorEnvelope>>;
}

export type PendingWorkKind =
  | "issue"
  | "review"
  | "write"
  | "delivery"
  | "verification"
  | "human_decision";

export interface PendingWorkItem {
  readonly kind: PendingWorkKind;
  /** Full ID or SourceRef of an existing object. */
  readonly ref: string;
  readonly reason_code: "queued" | "in_progress" | "awaiting_human" | "awaiting_evidence";
}

export interface TaskOutcomeRecord {
  readonly schema_version: "rsi.task_outcome/2";
  readonly outcome_id: Id<"out">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly binding: VersionBinding;
  readonly revision: number;
  readonly outcome: TaskOutcome;
  readonly success_evidence_refs: SourceRef[];
  readonly uncovered_requirement_ids: Id<"req">[];
  readonly pending_work: PendingWorkItem[];
  readonly reason_code:
    | "none"
    | "no_success_evidence"
    | "pending_work"
    | "human_cancel"
    | "human_pause"
    | "external_blocker"
    | "verification_failed"
    | "scope_uncovered"
    | "version_stale"
    | "boundary_unstable";
  readonly boundary_event_id: Id<"ev"> | null;
  readonly decided_at: number;
  readonly outcome_hash: Hash;
}

export interface TaskOutcomeEvaluationInput {
  readonly binding: VersionBinding;
  readonly outcome_id: Id<"out">;
  readonly revision: number;
  readonly previous: TaskOutcomeRecord | null;
  readonly active_requirements: readonly ActiveRequirement[];
  readonly success_evidence: readonly SuccessEvidence[];
  /** Facts the evidence chain depends on, used only for the stale check. */
  readonly supporting_facts: readonly StateFactView[];
  readonly pending_work: readonly PendingWorkItem[];
  readonly unresolved_issue_ids: readonly Id<"issue">[];
  /**
   * Explicit human/user cancellation or pause. Any other origin (including
   * `user` derived from hooks without a typed event) is rejected by validation.
   */
  readonly explicit_lifecycle_event: ExplicitLifecycleEvent | null;
  /** Blocker references for externally blocked work; keeps the outcome active. */
  readonly external_blockers: readonly string[];
  readonly boundary_event_id: Id<"ev"> | null;
  readonly decided_at: number;
}

export interface ActiveRequirement {
  readonly requirement_id: Id<"req">;
  readonly acceptance: AcceptanceCriterion[];
}

export interface ExplicitLifecycleEvent {
  readonly kind: "cancel" | "pause";
  readonly event_id: Id<"ev">;
  readonly origin: Origin;
  readonly directive_strength: "explicit";
}

export interface LedgerView {
  readonly binding: VersionBinding;
  readonly requirements: CurrentRequirement[];
  readonly facts: StateFactView[];
  readonly feedback: FeedbackRecord[];
  readonly corrections: LedgerCorrection[];
  readonly constraints: UnverifiedConstraint[];
  readonly outcome: TaskOutcomeRecord | null;
  readonly view_hash: Hash;
}

export interface LedgerEvidenceSnapshot {
  readonly schema_version: "rsi.ledger_evidence_snapshot/1";
  readonly binding: VersionBinding;
  readonly view_hash: Hash;
  readonly constraints_view_hash: Hash;
  readonly active_requirement_ids: readonly Id<"req">[];
  readonly requirements: readonly LedgerRequirementRow[];
  readonly requirement_ops: readonly LedgerRequirementOpRow[];
  readonly feedback: readonly LedgerFeedbackRow[];
  readonly constraints: readonly UnverifiedConstraint[];
}

export interface EvidenceLedgerReadQuery {
  readonly binding: VersionBinding;
}

export interface EvidenceLedgerReadPort {
  readEvidenceLedger(
    q: EvidenceLedgerReadQuery,
  ): Promise<Result<LedgerEvidenceSnapshot, ErrorEnvelope>>;
}
