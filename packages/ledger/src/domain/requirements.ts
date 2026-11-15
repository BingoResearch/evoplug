import type {
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";
import type {
  DirectiveStrength,
  Origin,
  RequirementOpKind,
  RequirementOpStatus,
} from "./common.js";

export interface RequirementScope {
  /** UTF-8 sorted; glob syntax version is fixed by the design. */
  readonly paths: string[];
  readonly hosts: string[];
  readonly modes: Array<"online" | "review" | "trial" | "global">;
  readonly project_ids: string[];
}

export type AcceptanceCriterion =
  | { readonly kind: "human_acceptance"; readonly source_ref: SourceRef }
  | { readonly kind: "test_pass"; readonly command: string; readonly cwd: string }
  | { readonly kind: "artifact_check"; readonly path: string; readonly expected_hash?: Hash }
  | {
      readonly kind: "external_verification";
      readonly verifier: string;
      readonly evidence_ref: SourceRef;
    };

export interface RequirementOpDraft {
  readonly schema_version: "rsi.requirement_op/1";
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly source_event_id: Id<"ev">;
  readonly actor_origin: Origin;
  readonly directive_strength: DirectiveStrength;
  readonly op: RequirementOpKind;
  readonly target_requirement_id: Id<"req"> | null;
  /** UTF-8 sorted. */
  readonly superseded_requirement_ids: Id<"req">[];
  readonly statement_text: string;
  readonly scope: RequirementScope;
  /** Sorted by kind and its stable fields. */
  readonly acceptance: AcceptanceCriterion[];
  readonly source_quote_ref: SourceRef;
  readonly source_text_hash: Hash;
}

export interface RequirementOpRecord extends Omit<RequirementOpDraft, "schema_version"> {
  readonly schema_version: "rsi.requirement_op_record/1";
  readonly op_id: Id<"reqop">;
  /** Non-null for add/clarify/supersede; null for retract/confirm. */
  readonly statement_ref: SourceRef | null;
  readonly status: RequirementOpStatus;
  readonly created_requirement_id: Id<"req"> | null;
  readonly effective_input_epoch: number;
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly recorded_at: number;
  readonly content_hash: Hash;
}

export interface RequirementOpResult {
  /** Frozen extraction result, including `statement_text`. */
  readonly draft: RequirementOpDraft;
  /** `null` means the source may apply the op when origin rules allow it. */
  readonly extractor_status: "proposed" | "conflict" | "rejected" | null;
  /** UTF-8 sorted. */
  readonly conflict_requirement_ids: Id<"req">[];
}

export interface UnverifiedConstraintDraft {
  readonly quote: string;
  readonly quote_hash: Hash;
  readonly source_ref: SourceRef;
  readonly scope_hint: RequirementScope | null;
  readonly usable_for: Array<"context" | "review" | "trial">;
  readonly conflict_with_requirement_ids: Id<"req">[];
}

export interface UnverifiedConstraint {
  readonly schema_version: "rsi.unverified_constraint/2";
  readonly constraint_id: Id<"uc">;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  readonly binding: VersionBinding;
  readonly source_event_id: Id<"ev">;
  /** Snapshot `source_refs` is exactly this single-element array. */
  readonly source_ref: SourceRef;
  readonly quote: string;
  readonly quote_hash: Hash;
  readonly scope_hint: RequirementScope | null;
  readonly status: "unverified_constraint" | "confirmed" | "rejected";
  /** Database constant; no code path may change it. */
  readonly authorization: 0;
  readonly usable_for: Array<"context" | "review" | "trial">;
  readonly conflict_with_requirement_ids: Id<"req">[];
  readonly confirmed_by_event_id: Id<"ev"> | null;
  readonly recorded_at_watermark: number;
  readonly created_at: number;
  readonly row_version: number;
}

export interface CurrentRequirement {
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  readonly statement_ref: SourceRef;
  readonly statement_text_hash: Hash;
  readonly scope: RequirementScope;
  readonly acceptance: AcceptanceCriterion[];
  readonly status: "proposed" | "active";
  readonly source_refs: SourceRef[];
}

export interface LedgerRequirementRow {
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  readonly statement_ref: SourceRef;
  readonly statement_text_hash: Hash;
  readonly scope: RequirementScope;
  readonly acceptance: AcceptanceCriterion[];
  readonly status: "proposed" | "active" | "superseded" | "retracted" | "rejected";
  readonly created_by_op_id: Id<"reqop">;
  readonly valid_from_event: number;
  readonly valid_to_event: number | null;
  readonly effective_input_epoch: number;
  readonly content_hash: Hash;
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
  readonly goal_version: string;
  /** Sorted, de-duplicated union of `statement_ref` and `requirement_source`. */
  readonly source_refs: SourceRef[];
}

export interface LedgerRequirementOpRow {
  readonly op_id: Id<"reqop">;
  readonly status: RequirementOpStatus;
  readonly op: RequirementOpKind;
  readonly actor_origin: Origin;
  readonly directive_strength: DirectiveStrength;
  readonly target_requirement_id: Id<"req"> | null;
  readonly created_requirement_id: Id<"req"> | null;
  readonly effective_input_epoch: number;
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly valid_from_event: number;
  readonly valid_to_event: number | null;
  readonly recorded_at: number;
  readonly recorded_at_watermark: number;
  readonly source_quote_ref: SourceRef;
  readonly content_hash: Hash;
}

export interface RecordRequirementOpsRequest {
  readonly binding: VersionBinding;
  /** Committed input/feedback event. */
  readonly source_event_id: Id<"ev">;
  readonly results: ReadonlyArray<RequirementOpResult>;
  /** Constraints from unknown/unverified sources; may be empty. */
  readonly constraints: ReadonlyArray<UnverifiedConstraintDraft>;
}

export interface RecordRequirementOpsResult {
  readonly op_ids: Id<"reqop">[];
  readonly requirement_ids: Id<"req">[];
}

export interface RequirementWritePort {
  recordRequirementOps(
    input: RecordRequirementOpsRequest,
  ): Promise<Result<RecordRequirementOpsResult, ErrorEnvelope>>;
}
