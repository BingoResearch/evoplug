/**
 * EVD public types (DD-EVD-001 … DD-EVD-026).
 *
 * FND shared types come from `@evoplug/core`. QP-owned read-only DTOs are
 * mirrored structurally in this module because the QP package has not landed
 * yet; when QP publishes its contract these mirrors must be replaced by
 * type-only imports. No EVD code redefines `Id`, `Hash`, `VersionBinding`,
 * `Result`, `ErrorEnvelope`, `SourceRef` or `JsonValue`.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  MethodRef,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";

export type { MethodRef, VersionBinding };

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Single load deadline in milliseconds (DD-EVD-003a-7). */
export const EVIDENCE_INDEX_LOAD_DEADLINE_MS = 30_000;
/** Per-source byte limit (DD-EVD-003a-7). */
export const MAX_SOURCE_BYTES = 1_048_576;
/** Total frozen bytes: source bytes plus JCS(rows) (DD-EVD-003a-7). */
export const MAX_TOTAL_FROZEN_BYTES = 33_554_432;
/** Unique source reference limit (DD-EVD-003a-7). */
export const MAX_INDEX_SOURCE_REFS = 4_096;
/** Row limit across snapshot collections (DD-EVD-003a-7). */
export const MAX_INDEX_ROWS = 100_000;
/** Single excerpt limit; identical to QP DD-QP-10. */
export const MAX_EXCERPT_BYTES = 4_096;
/** HOST progress checkpoint limit (DD-TRG-011). */
export const MAX_PROGRESS_CHECKPOINTS = 10_000;
/** HOST progress watermark span limit (DD-TRG-011). */
export const MAX_PROGRESS_WATERMARK_SPAN = 1_000_000;
/** Immutable EVD object blob limit (DD-EVD-024). */
export const MAX_EVD_OBJECT_BYTES = 33_554_432;
/** Default revalidation retries after a version conflict. */
export const DEFAULT_CONFLICT_RETRIES = 1;

export const COMPILER_VERSION = "evd-compiler/1";
export const COUNTING_METHOD_VERSION = "utf8-bytes/1";
export const SOURCE_MANIFEST_VERSION = "rsi.judge_state_manifest/1";
export const SHARD_POLICY_VERSION: "per_shard/1" = "per_shard/1";

export const AGGREGATION_POLICY_VERSION: "rsi.aggregate/2" = "rsi.aggregate/2";
export const AGGREGATION_POLICY_VERSION_V1: "rsi.aggregate/1" = "rsi.aggregate/1";
export const REVIEW_POLICY_VERSION: "rsi.aggregate.review/1" = "rsi.aggregate.review/1";
export const SEMANTIC_VALIDATOR_POLICY_VERSION: "rsi.semantic.validator/1" =
  "rsi.semantic.validator/1";
export const JEV_VALIDATOR_POLICY_VERSION: "rsi.judge.validator/1" = "rsi.judge.validator/1";

/* ------------------------------------------------------------------ */
/* QP mirror types (read-only)                                         */
/* ------------------------------------------------------------------ */

export type Origin = "human" | "agent" | "system" | "host" | "unknown";

export interface RequirementScope {
  paths: string[];
  hosts: string[];
  modes: Array<"online" | "review" | "trial" | "global">;
  project_ids: string[];
}

export type AcceptanceCriterion =
  | { kind: "human_acceptance"; source_ref: SourceRef }
  | { kind: "test_pass"; command: string; cwd: string }
  | { kind: "artifact_check"; path: string; expected_hash?: Hash }
  | { kind: "external_verification"; verifier: string; evidence_ref: SourceRef };

type StateProfile = "progress_issue" | "experience_review";

type QuestionType = "noul" | "choice" | "score" | "box";

export interface ChoiceOptionMapping {
  semantic_axis: string;
  semantic_value: string;
  option_effect: "supports" | "contradicts" | "unknown";
  issue_effect:
    | "supports" | "contradicts" | "unknown" | "not_applicable"
    | import("@evoplug/core/evidence").ChoiceOptionMapping["issue_effect"];
  requires_local_authorization?: boolean;
  can_close_issue?: false;
  can_satisfy_task?: false;
}

export interface ChoiceOption {
  option_key: string;
  description: string;
  mapping: ChoiceOptionMapping;
}

export interface PlannedQuestion {
  question_id: string;
  question_key: string;
  question_type: QuestionType;
  template_id: string;
  template_version: string;
  template_hash: Hash;
  options: ChoiceOption[];
  criteria: { true?: string; false?: string; levels?: string[]; [option_key: string]: string | string[] | undefined };
  instructions: string;
  required_views: string[];
  required_source_ids: string[];
  output_reserve_tokens: number;
  required_for_issue: boolean;
  proposition_id: string;
  requirement_ids: string[];
  option_effects: Record<string, "supports" | "contradicts" | "unknown">;
  answer_to_issue_map: Record<string, ChoiceOptionMapping>;
  independence: {
    answer_independent: boolean;
    state_profile: StateProfile;
    shareable: boolean;
  };
}

export interface EvidenceDependency {
  dependency_key: string;
  /** QP cross-domain question identity; never the local random `question_id`. */
  question_keys: string[];
  role: string;
  transport_role:
    | "requirement"
    | "feedback"
    | "artifact"
    | "verifier"
    | "counter"
    | "history"
    | "context";
  selection_rank: number;
  source_ids: string[];
  source_refs: SourceRef[];
  /** `sha256(JCS(sorted source_ids.map(id => PlanSource.content_hash)))`. */
  content_hash: Hash;
  artifact_version?: string;
  inseparable_group_key: string;
  relation: "supports" | "counter" | "context" | "defines" | "derived";
  omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  /** QP uses `null` for a plain unit; EVD copies the value verbatim. */
  derived_view_key: string | null;
}

/**
 * QP-declared source row (DD-QP-18/19). Only `source_id` and `content_hash`
 * participate in pack compilation: the plan freezes the content it planned
 * against and EVD rejects a dependency whose source is undeclared or whose
 * current bytes no longer match the frozen hash.
 */
export interface PlanSource {
  source_id: string;
  kind: string;
  source_refs: SourceRef[];
  content_hash: Hash;
  version: string | null;
  subject: string | null;
  fact_kind: string | null;
  fact_value_hash: Hash | null;
  role: "support" | "counter" | "context" | "definition" | "target";
  retrievable: boolean;
  requirement_ids: string[];
}

export interface QuestionPlan {
  plan_id: Id;
  plan_hash: Hash;
  planner_version: string;
  issue_id: Id;
  issue_key: string;
  issue_type: string;
  binding: VersionBinding;
  state_profile: StateProfile;
  sources: PlanSource[];
  questions: PlannedQuestion[];
  dependencies: EvidenceDependency[];
  required_source_ids: string[];
  required_views: string[];
  aggregate_output_reserve_tokens: number;
  /**
   * Not part of the persisted QP plan (DD-QP-30/DD-EVD-022A). Production
   * reads the lifecycle through `PlanReadPort.readPlanForAggregate`; this
   * optional field only keeps direct `buildJudgeRequest` fixtures usable.
   */
  plan_state?: "active" | "superseded" | "stale_goal" | "stale_binding" | "stale_template" | "rejected";
  supersedes_plan_id?: Id;
}

/** Minimal QP issue projection consumed by the pack compiler. */
export interface IssueView {
  issue_id: Id;
  issue_key: string;
  question: string;
  requirement_ids: string[];
  issue_type: string;
}

/** Structural `rsi.judge_state/2`; QP owns the discriminated union. */
export interface JudgeState {
  schema_version: string;
  profile: StateProfile;
  binding: VersionBinding;
  question_scope: {
    issue_type: string;
    scope_kind: string;
    requirement_ids: string[];
    artifact_paths: string[];
    whole_task_verdict_requested: boolean;
    issue_id?: string;
  };
  coverage: {
    missing: Array<{
      code: string;
      logical_id?: string;
      source_refs?: SourceRef[];
      affects_question_ids: string[];
    }>;
    omitted: Array<{
      logical_id?: string;
      reason: string;
      affects_question_ids: string[];
    }>;
  };
  requirements: Array<{
    requirement_id: string;
    source_id?: string;
    quote: string;
    source_refs?: SourceRef[];
  }>;
  latest_input?: JsonValue;
  evidence: Array<{
    display_id: string;
    logical_id: string;
    role: string;
    excerpt: string;
    artifact_version?: string;
    requirement_ids: string[];
    source_refs?: SourceRef[];
  }>;
  comparison?: JsonValue;
  task_conditions?: JsonValue;
  experience_candidates?: JsonValue;
}

export interface ReviewSnapshotView {
  schema_version: "rsi.review_snapshot_view/1";
  snapshot_id: string;
  snapshot_hash: Hash;
  binding: VersionBinding;
  watermark: number;
  candidate: {
    experience_id: string;
    version: number;
    content_hash: Hash;
    type: string;
    title: string;
    summary: string;
    trigger: ExperienceTriggerView;
    scope: ExperienceScopeView;
    preconditions: JsonValue[];
    steps: JsonValue[];
    expected_effects: string[];
    completion_check: JsonValue;
    counterexamples: JsonValue[];
    risk: "low" | "medium" | "high";
    validation_plan_id: string;
    evidence_refs: SourceRef[];
    source_refs: SourceRef[];
    excerpt: string;
    text_hash: Hash;
  };
  shortlist: Array<{
    experience_id: string;
    version: number;
    content_hash: Hash;
    relation: "same_family" | "overlap" | "similar_trigger";
    excerpt: string;
    source_refs: SourceRef[];
    text_hash: Hash;
  }>;
  local_checks: {
    static_check_passed: boolean;
  };
}

export interface ExperienceTriggerView {
  issue_types: string[];
  keywords: string[];
}

export interface ExperienceScopeView {
  paths: string[];
  components: string[];
}

export interface ProjectionValidationInput {
  state: JudgeState;
  plan: QuestionPlan;
  questions: PlannedQuestion[];
}

export interface ProjectionValidationResult {
  ok: boolean;
  code?: string;
  details?: Record<string, JsonValue>;
}

export interface PlanReadPort {
  readPlanForAggregate(q: {
    plan_id: Id;
    expected_plan_hash: Hash;
    binding: VersionBinding;
  }): PlanReadResult | Promise<PlanReadResult>;
}

export type PlanReadResult =
  | { ok: true; value: AggregatePlanView }
  | { ok: false; code: string; error: ErrorEnvelope; plan?: AggregatePlanView };

export interface AggregatePlanView {
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  issue_key: string;
  binding: VersionBinding;
  plan_state: QuestionPlan["plan_state"];
  state_profile: StateProfile;
  aggregate_output_reserve_tokens: number;
  questions: Array<{
    question_key: string;
    question_type: QuestionType;
    template_id: string;
    template_version: string;
    template_hash: Hash;
    options: ChoiceOption[];
    criteria: PlannedQuestion["criteria"];
    instructions: string;
    required_for_issue: boolean;
    proposition_id: string;
    requirement_ids: string[];
    option_effects: Record<string, "supports" | "contradicts" | "unknown">;
    answer_to_issue_map: Record<string, ChoiceOptionMapping>;
    independence: PlannedQuestion["independence"];
  }>;
}

/* ------------------------------------------------------------------ */
/* Evidence index DTOs (DD-EVD-003b)                                   */
/* ------------------------------------------------------------------ */

export type StateFactKind =
  | "code"
  | "interface_contract"
  | "call"
  | "result"
  | "diff"
  | "test"
  | "message";

export type ProgressSignalStatus =
  | "comparable"
  | "pending"
  | "blocked"
  | "paused"
  | "cancelled"
  | "capture_gap"
  | "unknown";

export type RequirementStatus = "proposed" | "active" | "superseded" | "retracted" | "rejected";

type FeedbackSignalKind = "correction" | "dissatisfaction" | "new_goal" | "acceptance";

export type FactStatus = "observed" | "verified" | "contradicted" | "unknown";

export type RequirementOpStatus = "applied" | "proposed" | "conflict" | "rejected";

export type TaskProcessState =
  | "baseline"
  | "advancing"
  | "information_gain"
  | "stalled_candidate"
  | "regressing"
  | "blocked"
  | "paused"
  | "cancelled"
  | "waiting"
  | "collection_gap"
  | "unknown";

export interface RequirementView {
  schema_version: "rsi.requirement_view/1";
  requirement_id: string;
  revision: number;
  statement_ref: SourceRef;
  statement_text_hash: Hash;
  scope: RequirementScope;
  acceptance: AcceptanceCriterion[];
  source_refs: SourceRef[];
  status: RequirementStatus;
  recorded_at: number;
  recorded_at_watermark: number;
  valid_from_event: number;
  valid_to_event: number | null;
  goal_version: string;
  content_hash: Hash;
}

export interface RequirementOpView {
  schema_version: "rsi.requirement_op_view/1";
  op_id: string;
  status: RequirementOpStatus;
  op: "add" | "clarify" | "supersede" | "retract" | "confirm";
  actor_origin: Origin;
  directive_strength: "explicit" | "ambiguous";
  target_requirement_id: string | null;
  created_requirement_id: string | null;
  effective_input_epoch: number;
  goal_version_before: string;
  goal_version_after: string;
  valid_from_event: number;
  valid_to_event: number | null;
  recorded_at: number;
  recorded_at_watermark: number;
  source_quote_ref: SourceRef;
  content_hash: Hash;
}

export interface FeedbackView {
  schema_version: "rsi.feedback_view/1";
  feedback_id: string;
  target_issue_id: string | null;
  origin: Origin;
  signal_kind: FeedbackSignalKind;
  status: "recorded" | "needs_evidence";
  goal_version: string;
  input_epoch: number;
  source_refs: SourceRef[];
  recorded_at: number;
  recorded_at_watermark: number;
}

export interface EvidenceFactView {
  schema_version: "rsi.evidence_fact_view/1";
  fact_id: string;
  requirement_id?: string;
  proposition_id?: string;
  kind: StateFactKind;
  subject: string;
  value: string;
  fact_value_hash: Hash;
  status: FactStatus;
  effect: "supports" | "violates" | "unknown";
  stale: false;
  source_refs: SourceRef[];
  artifact_version?: string;
  verified: boolean;
  recorded_at: number;
  recorded_at_watermark: number;
  row_version: number;
}

export interface ProgressSignalView {
  schema_version: "rsi.progress_signal_view/1";
  signal_id: string;
  signal_kind: TaskProcessState;
  status: ProgressSignalStatus;
  capture_reason?:
    | "evidence_coverage_gap"
    | "pending_unknown"
    | "baseline_missing"
    | "task_state_unknown";
  source_refs: SourceRef[];
  baseline_checkpoint_id?: string;
  previous_comparable_checkpoint_id?: string;
  comparison_view_key?: Hash;
  from_watermark: number;
  to_watermark: number;
  recorded_at: number;
}

export interface ExperienceCandidateView {
  schema_version: "rsi.experience_candidate_view/1";
  candidate_id: string;
  experience_id: string;
  version: number;
  content_hash: Hash;
  type: string;
  title: string;
  summary: string;
  trigger: ExperienceTriggerView;
  scope: ExperienceScopeView;
  preconditions: JsonValue[];
  steps: JsonValue[];
  expected_effects: string[];
  completion_check: JsonValue;
  counterexamples: JsonValue[];
  risk: "low" | "medium" | "high";
  validation_plan_id: string;
  evidence_refs: SourceRef[];
  source_refs: SourceRef[];
  excerpt: string;
  text_hash: Hash;
  static_check_status: "passed" | "failed";
  shortlist: Array<{
    experience_id: string;
    version: number;
    content_hash: Hash;
    relation: "same_family" | "overlap" | "similar_trigger";
    excerpt: string;
    source_refs: SourceRef[];
    text_hash: Hash;
  }>;
}

export interface CoverageSnapshotView {
  schema_version: "rsi.coverage_snapshot_view/1";
  snapshot_id: string;
  binding: VersionBinding;
  watermark: number;
  scope: "ledger_scan/1";
  searched_sources: string[];
  checked_requirement_ids: string[];
  counterevidence_complete_for: string[];
  missing: Array<{
    code: "capture_gap" | "verifier_absent" | "artifact_version_unknown" | "conflicting_sources";
    requirement_id: string;
    logical_id: string;
    source_refs: SourceRef[];
    fact_keys?: Hash[];
    affects_question_ids: string[];
  }>;
  complete: boolean;
  source_refs: SourceRef[];
}

export interface TaskConditionView {
  schema_version: "rsi.task_condition_view/1";
  logical_id: string;
  condition_id: string;
  requirement_ids: string[];
  text: string;
  text_hash: Hash;
  source_ids: string[];
  source_refs: SourceRef[];
  origin: "human";
}

export interface UnverifiedConstraintView {
  schema_version: "rsi.unverified_constraint_view/1";
  logical_id: string;
  constraint_id: string;
  version_binding: VersionBinding;
  recorded_at_watermark: number;
  source_event_id: string;
  source_refs: SourceRef[];
  quote: string;
  quote_hash: Hash;
  scope_hint: RequirementScope | null;
  status: "unverified_constraint" | "confirmed" | "rejected";
  authorization: false;
  confirmed_by_event_id: string | null;
  created_at: number;
  row_version: number;
}

export interface ComparisonView {
  schema_version: "rsi.comparison_view/1";
  view_key: Hash;
  comparability_key: Hash;
  baseline_evidence_digest: Hash;
  current_evidence_digest: Hash;
  baseline_source_ids: string[];
  current_source_ids: string[];
  before_watermark: number;
  after_watermark: number;
  source_refs: SourceRef[];
}

export interface CoverageView {
  schema_version: "rsi.coverage_view/1";
  view_key: Hash;
  scope: "ledger_scan/1";
  checked_requirement_ids: string[];
  searched_sources: string[];
  missing_codes: Array<CoverageSnapshotView["missing"][number]["code"]>;
  source_refs: SourceRef[];
}

export interface HardFactReadView {
  schema_version: "rsi.hard_fact_view/1";
  fact_id: string;
  fact_key: Hash;
  independence_key: Hash;
  requirement_id: string;
  proposition_id?: string;
  effect: "supports" | "violates";
  source_ids: string[];
  source_refs: SourceRef[];
  artifact_version?: string;
  verifier_ref: SourceRef;
  verified: true;
  recorded_at: number;
}

/* ------------------------------------------------------------------ */
/* Evidence index port (DD-EVD-003)                                    */
/* ------------------------------------------------------------------ */

export type ExcerptWindow =
  | { kind: "exact" }
  | { kind: "sentence"; max_sentences: number }
  | { kind: "line"; max_lines: number }
  | { kind: "around_offset"; utf8_offset: number; max_sentences: number };

export type ExcerptReadResult =
  | { ok: true; bytes: Uint8Array; text_hash: Hash; source_ref: SourceRef }
  | {
      ok: false;
      code:
        | "E_SOURCE_REF_INVALID"
        | "E_SOURCE_OUT_OF_RANGE"
        | "E_SOURCE_UTF8_INVALID"
        | "E_SOURCE_TOO_LARGE"
        | "E_SOURCE_NOT_FOUND";
      source_ref: SourceRef;
    };

export type EvidenceIndexPortErrorCode =
  | "E_INDEX_SCOPE_MISMATCH"
  | "E_INDEX_WINDOW_INVALID"
  | "E_INDEX_SNAPSHOT_ID_MISMATCH"
  | "E_INDEX_REVIEW_SNAPSHOT_MISSING";

export interface EvidenceIndexPortErrorShape {
  schema_version: "rsi.evidence_index_port_error/1";
  code: EvidenceIndexPortErrorCode;
  message_key: string;
  details: Readonly<Record<string, JsonValue>>;
}

export class EvidenceIndexPortError extends Error {
  readonly schema_version: "rsi.evidence_index_port_error/1" =
    "rsi.evidence_index_port_error/1";
  readonly code: EvidenceIndexPortErrorCode;
  readonly message_key: string;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(init: EvidenceIndexPortErrorShape) {
    super(init.message_key);
    this.name = "EvidenceIndexPortError";
    this.code = init.code;
    this.message_key = init.message_key;
    this.details = init.details;
  }
}

export interface EvidenceIndexPort {
  listRequirements(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
    statuses?: readonly RequirementStatus[];
  }): readonly RequirementView[];
  listRequirementOps(q: {
    binding: VersionBinding;
    watermark: number;
    statuses?: readonly RequirementOpStatus[];
    requirement_ids?: readonly string[];
  }): readonly RequirementOpView[];
  listFeedback(q: {
    binding: VersionBinding;
    watermark: number;
    target_issue_id?: string;
  }): readonly FeedbackView[];
  listFacts(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
    fact_ids?: readonly string[];
    kinds?: readonly StateFactKind[];
    statuses?: readonly FactStatus[];
    artifact_version?: string;
  }): readonly EvidenceFactView[];
  listProgressSignals(q: {
    binding: VersionBinding;
    from_watermark: number;
    to_watermark: number;
    checkpoint_ids?: readonly string[];
  }): readonly ProgressSignalView[];
  listExperienceCandidates(q: {
    binding: VersionBinding;
    review_snapshot_id: string;
    experience_ids?: readonly string[];
  }): readonly ExperienceCandidateView[];
  getCoverageSnapshot(q: {
    binding: VersionBinding;
    watermark: number;
    snapshot_id?: string;
  }): CoverageSnapshotView;
  listTaskConditions(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
  }): readonly TaskConditionView[];
  listUnverifiedConstraints(q: {
    binding: VersionBinding;
    watermark: number;
    statuses?: Array<"unverified_constraint" | "confirmed" | "rejected">;
  }): readonly UnverifiedConstraintView[];
  listComparisons(q: {
    binding: VersionBinding;
    watermark: number;
    view_keys?: readonly string[];
  }): readonly ComparisonView[];
  listCoverageViews(q: {
    binding: VersionBinding;
    watermark: number;
    view_keys?: readonly string[];
  }): readonly CoverageView[];
  listHardFacts(q: {
    binding: VersionBinding;
    watermark: number;
    requirement_ids?: readonly string[];
    proposition_ids?: readonly string[];
    artifact_version?: string;
  }): readonly HardFactReadView[];
  checkRetrievable(
    refs: readonly SourceRef[]
  ): readonly { source_ref: SourceRef; retrievable: boolean; content_hash?: Hash }[];
  readExcerpt(ref: SourceRef, window: ExcerptWindow, maxBytes: number): ExcerptReadResult;
}

export interface EvidenceIndexSnapshot extends EvidenceIndexPort {
  readonly schema_version: "rsi.evidence_index_snapshot/1";
  readonly binding: VersionBinding;
  readonly watermark: number;
  readonly progress_from_watermark: number;
  readonly ledger_view_hash: Hash;
  readonly constraints_view_hash: Hash;
  readonly source_set_hash: Hash;
  readonly review_snapshot_id: string | null;
  readonly review_snapshot_hash: Hash | null;
  readonly snapshot_hash: Hash;
  readonly row_counts: Readonly<{
    requirements: number;
    requirement_ops: number;
    feedback: number;
    unverified_constraints: number;
    facts: number;
    progress_signals: number;
    experience_candidates: number;
    task_conditions: number;
    comparisons: number;
    coverage_views: number;
    hard_facts: number;
  }>;
}

/* ------------------------------------------------------------------ */
/* Loader requests and upstream read ports                             */
/* ------------------------------------------------------------------ */

export interface EvidenceIndexLoadRequest {
  schema_version: "rsi.evidence_index_load_request/1";
  binding: VersionBinding;
  watermark: number;
  progress_from_watermark: number;
  review_snapshot_id?: string;
  review_snapshot?: ReviewSnapshotView;
}

export interface EvdIndexLoadError {
  schema_version: "rsi.evidence_index_load_error/1";
  code: string;
  category:
    | "usage"
    | "schema"
    | "version"
    | "not_found"
    | "policy"
    | "authorization"
    | "budget"
    | "deadline"
    | "source"
    | "conflict"
    | "storage"
    | "ipc"
    | "capacity"
    | "external"
    | "internal";
  stage:
    | "validate"
    | "ledger_read"
    | "facts_read"
    | "progress_read"
    | "sources_resolve"
    | "sources_validate"
    | "revalidate"
    | "freeze";
  retryable: boolean;
  side_effect: "none";
  message_key: string;
  details: Readonly<Record<string, JsonValue>>;
}

export type EvdIndexLoadResult<T> =
  | { ok: true; status: "ok"; value: T }
  | { ok: false; status: "rejected"; error: EvdIndexLoadError };

export interface EvidenceIndexSnapshotLoader {
  load(
    q: EvidenceIndexLoadRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<EvdIndexLoadResult<EvidenceIndexSnapshot>>;
}

/** FND `LedgerEvidenceSnapshot` structural mirror (DD-FND-074). */
export interface LedgerRequirementRow {
  requirement_id: string;
  revision: number;
  statement_ref: SourceRef;
  statement_text_hash: Hash;
  scope: RequirementScope;
  acceptance: AcceptanceCriterion[];
  status: RequirementStatus;
  created_by_op_id: string;
  goal_version: string;
  recorded_at: number;
  recorded_at_watermark: number;
  valid_from_event: number;
  valid_to_event: number | null;
  content_hash: Hash;
  source_refs: SourceRef[];
}

export interface LedgerRequirementOpRow {
  op_id: string;
  status: RequirementOpStatus;
  op: "add" | "clarify" | "supersede" | "retract" | "confirm";
  actor_origin: Origin;
  directive_strength: "explicit" | "ambiguous";
  target_requirement_id: string | null;
  created_requirement_id: string | null;
  effective_input_epoch: number;
  goal_version_before: string;
  goal_version_after: string;
  valid_from_event: number;
  valid_to_event: number | null;
  recorded_at: number;
  recorded_at_watermark: number;
  source_quote_ref: SourceRef;
  content_hash: Hash;
}

export interface LedgerFeedbackRow {
  feedback_id: string;
  target_issue_id: string | null;
  origin: Origin;
  signal_kind: FeedbackSignalKind;
  status: "recorded" | "needs_evidence";
  goal_version: string;
  input_epoch: number;
  source_refs: SourceRef[];
  recorded_at: number;
  recorded_at_watermark: number;
}

interface UnverifiedConstraintRow {
  constraint_id: string;
  version_binding: VersionBinding;
  recorded_at_watermark: number;
  source_event_id: string;
  source_ref: SourceRef;
  quote: string;
  quote_hash: Hash;
  scope_hint: RequirementScope | null;
  status: "unverified_constraint" | "confirmed" | "rejected";
  confirmed_by_event_id: string | null;
  created_at: number;
  row_version: number;
}

export interface LedgerEvidenceSnapshot {
  schema_version: "rsi.ledger_evidence_snapshot/1";
  binding: VersionBinding;
  view_hash: Hash;
  constraints_view_hash: Hash;
  active_requirement_ids: readonly string[];
  requirements: readonly LedgerRequirementRow[];
  requirement_ops: readonly LedgerRequirementOpRow[];
  feedback: readonly LedgerFeedbackRow[];
  constraints: readonly UnverifiedConstraintRow[];
}

export interface EvidenceLedgerReadPort {
  readEvidenceLedger(q: {
    binding: VersionBinding;
  }): Promise<Result<LedgerEvidenceSnapshot, ErrorEnvelope>>;
}

export interface StateFactView {
  schema_version: "rsi.state_fact/1";
  fact_id: string;
  binding: VersionBinding;
  kind: StateFactKind;
  subject: string;
  value: string;
  truth_state: "claim" | "observed" | "verified" | "contradicted" | "unknown";
  stale: boolean;
  stale_reason: string | null;
  source_ref: SourceRef;
  producer_ref: SourceRef;
  verifier_ref: SourceRef | null;
  artifact_version: string | null;
  observed_at: number;
  verifiers: VerifierRegistryView[];
  row_version: number;
}

export interface VerifierRegistryView {
  schema_version: "rsi.fact_verification/1";
  fact_id: string;
  event_id: string;
  verifier_ref: SourceRef;
  verifier_id: string;
  verifier_kind: "test" | "artifact_check" | "external" | "human";
  method_ref: JsonValue | null;
  reservation_ids: readonly string[];
  independent: boolean;
  verification_binding: VersionBinding;
  requirement_ids: string[];
  proposition_ids: string[];
  effect: "supports" | "violates" | "unknown";
  artifact_version: string | null;
  source_ids: string[];
  source_refs: SourceRef[];
  result: "verified" | "contradicted" | "unknown";
  status: "valid" | "invalidated" | "unknown";
  verified_at: number;
  row_version: number;
}

export interface FactReadPort {
  listFacts(q: { binding: VersionBinding }): Promise<readonly StateFactView[]>;
}

export interface VerifierRegistryPort {
  listVerifiers(q: {
    binding: VersionBinding;
    statuses: readonly ["valid"];
  }): Promise<readonly VerifierRegistryView[]>;
}

export interface ProgressCheckpointReadView {
  schema_version: "rsi.progress_checkpoint/1";
  checkpoint_id: string;
  binding: VersionBinding;
  watermark: number;
  task_process_state: TaskProcessState;
  comparability_key: Hash;
  evidence_digest: Hash;
  evidence_coverage: "complete" | "partial" | "gap";
  pending_state: "none" | "pending" | "unknown";
  baseline_checkpoint_id: string | null;
  previous_comparable_checkpoint_id: string | null;
  source_refs: SourceRef[];
  created_at: number;
}

export interface ProgressCheckpointReadError {
  code:
    | "E_PROGRESS_REQUEST"
    | "E_PROGRESS_WINDOW"
    | "E_PROGRESS_HISTORY_MISSING"
    | "E_PROGRESS_LIMIT"
    | "E_PROGRESS_SCOPE_MISMATCH"
    | "E_PROGRESS_DATA"
    | "E_PROGRESS_STORAGE"
    | "E_PROGRESS_DEADLINE"
    | "E_PROGRESS_CANCELLED";
  upstream_code?: string;
}

export interface ListProgressCheckpointsQuery {
  request_id: Id;
  binding: VersionBinding;
  from_watermark: number;
  to_watermark: number;
  read_only_history: true;
  deadline_ms: number;
  signal: AbortSignal;
}

type ProgressReadResult<T> =
  | { ok: true; status: "ok"; value: T }
  | { ok: false; status: "rejected"; error: ProgressCheckpointReadError };

export interface ProgressCheckpointReadPort {
  listCheckpoints(
    q: ListProgressCheckpointsQuery
  ): Promise<ProgressReadResult<readonly ProgressCheckpointReadView[]>>;
}

export interface EvidenceIndexSnapshotLoaderDeps {
  ledger: EvidenceLedgerReadPort;
  facts: FactReadPort;
  verifiers: VerifierRegistryPort;
  sources: {
    resolve(
      ref: SourceRef,
      opts?: { maxBytes?: number }
    ): Promise<Result<FrozenResolvedSource, ErrorEnvelope>>;
    checkRetrievable(
      refs: readonly SourceRef[]
    ): Promise<ReadonlyMap<SourceRef, FrozenResolvedSource>>;
  };
  progress: ProgressCheckpointReadPort;
  monotonic_now: () => number;
}

export interface FrozenResolvedSource {
  bytes: Uint8Array | null;
  length: number;
  retrievable: boolean;
  contentVersion: Hash | null;
  range_content_hash: Hash | null;
  reason?: "missing" | "tombstoned" | "hash_mismatch" | "too_large";
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Budget fields EVD consumes (DD-EVD-013). FND `RunBudget` is the authority;
 * the structural shape keeps EVD buildable until the budget package is wired.
 */
export interface RunBudget {
  schema_version?: string;
  budget_id?: Id;
  run_id?: Id;
  request_max_tokens: number | null;
  question_max_tokens: number | null;
  request_margin_tokens: number;
  question_margin_tokens: number;
  max_attempts: number;
  deadline_ms: number;
  max_cost_micros: number | null;
  remaining_ms?: number;
  execution_mode?: "normal" | "shadow" | "disabled";
}

export interface BudgetLimitsView {
  request_max_tokens: number | null;
  question_max_tokens: number | null;
  source: "official_docs" | "provider_metadata" | "unknown";
  source_refs: SourceRef[];
  limits_hash: Hash;
}

export interface BudgetEstimate {
  schema_version: "rsi.budget_estimate/1";
  estimate_id: Id;
  estimate_key: Hash;
  shard_id: Id;
  shard_key: Hash;
  plan_id: Id;
  service_profile_id: Id;
  service_profile_key: Hash;
  counting_method_version: string;
  estimator: {
    name: string;
    version: string;
    tokenizer_source: "provider_published" | "local_estimate";
    notes_version: string;
  };
  limits: BudgetLimitsView;
  frame_tokens: { request: number; per_question: Record<string, number> };
  state_tokens: number;
  question_tokens: Record<string, number>;
  reserves: {
    request_output: number;
    per_question_output: Record<string, number>;
    request_margin: number;
    per_question_margin: Record<string, number>;
  };
  checks: {
    request_total: number;
    request_ok: boolean;
    per_question: Array<{ question_key: string; total: number; ok: boolean }>;
  };
  verdict: "fits" | "exceeds_request" | "exceeds_question" | "limits_unknown";
  limiting_question_key?: string;
  headroom_tokens?: number;
  usage_calibration?: {
    observed_input_tokens: number;
    estimated_input_tokens: number;
    ratio: number;
    observed_at: number;
  };
  created_at: number;
  estimate_hash: Hash;
}

export interface SemanticBudgetEstimate {
  schema_version: "rsi.semantic_budget_estimate/1";
  estimate_id: Id;
  estimate_key: Hash;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  capability_key: Hash;
  capability_hash: Hash;
  service_profile_key: Hash;
  estimator: { name: "utf8-bytes"; version: "1" };
  limits: SemanticBackendLimits;
  counts: {
    questions: number;
    evidence_items: number;
    state_bytes: number;
    request_bytes: number;
    response_bytes: number;
  };
  checks: Array<{
    field: "questions" | "evidence_items" | "state_bytes" | "request_bytes" | "response_bytes";
    observed: number;
    limit: number;
    ok: boolean;
  }>;
  verdict: "fits" | "exceeds_request" | "limits_unknown";
  limiting_field: SemanticBudgetEstimate["checks"][number]["field"] | null;
  created_at: number;
  estimate_hash: Hash;
}

export interface BudgetInput {
  schema_version: "rsi.budget_input/1";
  plan_id: Id;
  plan_hash: Hash;
  pack_key: Hash;
  shards: Shard[];
  service_profile: JevServiceProfile | SemanticBackendCapability;
  limits: RunBudget;
  counting_method_version: string;
  /** Historical calibration observation; never written back into the estimate. */
  usage_calibration?: {
    observed_input_tokens: number;
    estimated_input_tokens: number;
  };
}

export interface SemanticBudgetInput {
  shard: Shard;
  capability: SemanticBackendCapability;
  request: SemanticBackendRequest;
  estimator: { name: "utf8-bytes"; version: "1" };
}

/* ------------------------------------------------------------------ */
/* Service profile                                                     */
/* ------------------------------------------------------------------ */

export interface JevServiceProfile {
  schema_version: "rsi.jev_service_profile/1";
  profile_id: Id;
  profile_key: Hash;
  profile_version: number;
  provider: "typesafe" | "openrouter";
  base_url: string;
  route: string;
  endpoint_contract_version: "rsi.jev.wire/1";
  requested_model: string;
  expected_returned_model: string;
  model_kind: "fixed" | "alias";
  observed_snapshot_id?: string;
  response_schema_version: "rsi.judge_wire/1";
  limits: BudgetLimitsView;
  long_context: {
    supported: "yes" | "no" | "unknown";
    enabled: false;
    source_refs: SourceRef[];
  };
  official_precision_policy: "none" | "documented";
  observed_wire_precision: {
    max_abs_confidence_delta: number;
    sample_count: number;
    observed_at: number;
    evidence_refs: SourceRef[];
  } | null;
  precision_contract: "none_published" | "documented";
  observed_failures: Array<{
    reported_confidence: number;
    recomputed_confidence: number;
    delta: number;
    error: "E_CONFIDENCE_MISMATCH";
  }>;
  production_use: boolean;
  credential_ref: string;
  acceptance: {
    status: "eligible" | "shadow_only" | "blocked";
    reasons: string[];
  };
  h_evidence_refs: SourceRef[];
  created_at: number;
}

export interface JevServiceState {
  schema_version: "rsi.jev_service_state/1";
  service_state_key: Hash;
  profile_key: Hash;
  current_profile_version: number;
  current_profile_id: Id;
  acceptance_status: "eligible" | "shadow_only" | "blocked";
  reason_codes: string[];
  updated_at: number;
  row_version: number;
}

type JevBackendKind = "jev_typed" | "local_classifier" | "other";

export interface SemanticScope {
  schema_version: "rsi.semantic_scope/1";
  question_classes: Array<
    | "intent_relation"
    | "behavior_relation"
    | "step_effect"
    | "acceptance_relation"
    | "experience_match"
  >;
  issue_types: string[];
  state_profiles: StateProfile[];
  evidence_kinds: Array<
    "source_excerpt" | "artifact" | "checkpoint_diff" | "verifier_result" | "experience"
  >;
}

export interface SemanticBackendLimits {
  schema_version: "rsi.semantic_backend_limits/1";
  state_supported: boolean;
  max_questions: number;
  max_evidence_items: number;
  max_state_bytes: number;
  max_request_bytes: number;
  max_response_bytes: number;
  limits_hash: Hash;
}

export interface SemanticBackendCapability {
  schema_version: "rsi.semantic_backend_capability/1";
  backend_key: Hash;
  capability_key: Hash;
  capability_hash: Hash;
  backend_kind: JevBackendKind;
  implementation_id: string;
  implementation_version: string;
  method: MethodRef;
  scope: SemanticScope;
  output_contracts: ["categorical_option/1"];
  transport_status: "verified" | "unknown" | "unsupported" | "failed";
  semantic_competence: Array<{
    question_class: SemanticScope["question_classes"][number];
    status: "calibrated" | "shadow_only" | "unknown";
    calibration_ref: SourceRef | null;
  }>;
  limits: SemanticBackendLimits;
  source_refs: SourceRef[];
}

export interface SemanticBackendRef {
  schema_version: "rsi.semantic_backend_ref/1";
  backend_key: Hash;
  backend_kind: JevBackendKind;
  method: MethodRef;
  scope_key: Hash;
  capability_key: Hash;
  capability_hash: Hash;
}

export interface ValidatorBinding {
  schema_version: "rsi.judge.validator_binding/1";
  validator_binding_id: Id;
  validator_binding_key: Hash;
  validator_policy_version: "rsi.judge.validator/1";
  validator_policy_hash: Hash;
  service_profile_id: Id;
  service_profile_key: Hash;
  response_schema_version: "rsi.judge_wire/1";
  tolerance_policy: "local_fixed";
  probability_sum_tolerance: 1e-6;
  confidence_tolerance: 1e-6;
  partial_batch: "reject_all";
  created_at: number;
}

export interface SemanticValidationBinding {
  schema_version: "rsi.semantic_validation_binding/1";
  validator_binding_id: Id;
  validator_binding_key: Hash;
  backend_key: Hash;
  capability_key: Hash;
  capability_hash: Hash;
  output_contract: "categorical_option/1";
  policy_version: "rsi.semantic.validator/1";
  policy_hash: Hash;
  contract_hash: Hash;
  created_at: number;
}

export interface ValidatorPolicy {
  policy_version: "rsi.judge.validator/1";
  choice_options_min: 2;
  choice_options_max: 255;
  score_levels_min: 2;
  score_levels_max: 10;
  probability_sum_tolerance: 1e-6;
  confidence_tolerance: 1e-6;
  unknown_option_key: "unknown";
  partial_batch: "reject_all";
  alias_policy: "shadow_only";
}

/* ------------------------------------------------------------------ */
/* Evidence pack / units / shards                                      */
/* ------------------------------------------------------------------ */

export interface EvidencePackRequirement {
  id: string;
  quote: string;
  source_refs: SourceRef[];
  source_id: string;
}

export interface EvidencePackFact {
  id: string;
  source_id: string;
  kind: "call" | "result" | "diff" | "test" | "message";
  role: "support" | "counter" | "context";
  excerpt: string;
  content_hash: Hash;
  source_refs: SourceRef[];
  version?: string;
  retrievable: boolean;
}

export interface CoverageMissingEntry {
  source_refs?: SourceRef[];
  source_id?: string;
  reason: string;
  affects_question_ids: string[];
  recoverable: boolean;
}

export interface EvidencePack {
  schema_version: "rsi.evidence_pack/2";
  pack_id: Id;
  pack_key: Hash;
  compiler_version: string;
  counting_method_version: string;
  source_manifest_version: string;
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  issue_key: string;
  issue: {
    question: string;
    requirement_ids: string[];
    issue_type: string;
  };
  question_ids: string[];
  question_keys: string[];
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
  requirements: EvidencePackRequirement[];
  feedback?: { quote: string; source_refs: SourceRef[]; source_id: string };
  facts: EvidencePackFact[];
  coverage: {
    checked_requirement_ids: string[];
    searched_sources: string[];
    omitted_refs: string[];
    missing: CoverageMissingEntry[];
  };
  budget: { input_tokens: number; output_reserve: number; deadline_ms: number };
  evidence_hash: Hash;
  pack_hash: Hash;
  pack_state:
    | "valid"
    | "stale_goal"
    | "stale_epoch"
    | "missing_source"
    | "stale_compiler"
    | "invalidated_source";
  created_at: number;
}

export interface DependencyUnitStateEvidence {
  logical_id: string;
  source_ids: string[];
  source_refs: SourceRef[];
  content_hash: Hash;
  text_hash: Hash;
  excerpt_hash: Hash;
  artifact_version?: string;
  excerpt: string;
}

export interface DependencyUnit {
  schema_version: "rsi.dependency_unit/1";
  unit_id: Id;
  unit_key: Hash;
  plan_id: Id;
  plan_hash: Hash;
  pack_id: Id;
  dependency_key: string;
  inseparable_group_key: string;
  question_ids: string[];
  role: string;
  transport_role:
    | "requirement"
    | "feedback"
    | "artifact"
    | "verifier"
    | "counter"
    | "history"
    | "context";
  relation: "supports" | "counter" | "context" | "defines" | "derived";
  source_ids: string[];
  source_refs: SourceRef[];
  artifact_version?: string;
  selection_rank: number;
  omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  derived_view_key?: string;
  state_evidence: DependencyUnitStateEvidence[];
  estimated_tokens: number;
  unit_hash: Hash;
}

export interface JudgeStateManifestEntry {
  display_ordinal: number;
  display_id: string;
  logical_id: string;
  source_ids: string[];
  source_refs: SourceRef[];
  role: string;
  text_hash: Hash;
  content_hash: Hash;
  excerpt_bytes: number;
  requirement_ids: string[];
  artifact_version?: string;
}

export interface JudgeStateManifest {
  schema_version: "rsi.judge_state_manifest/1";
  manifest_id: Id;
  manifest_key: Hash;
  state_hash: Hash;
  state_content_hash: Hash;
  shard_id: Id;
  shard_key: Hash;
  pack_key: Hash;
  plan_hash: Hash;
  entries: JudgeStateManifestEntry[];
  wire_removed_fields: string[];
  created_at: number;
  manifest_hash: Hash;
}

export type ShardStatus =
  | "planned"
  | "budget_rejected"
  | "projection_rejected"
  | "bound"
  | "sent"
  | "accepted"
  | "degraded"
  | "unknown"
  | "cancelled"
  /**
   * The deterministic dispatch layer settled every required question in this
   * shard from verified hard facts. The shard row is insert-only, carries no
   * request binding, no manifest and no envelope, and its omission row records
   * the skip provenance.
   */
  | "deterministic_skip";

export interface Shard {
  shard_id: Id;
  shard_key: Hash;
  question_ids: string[];
  question_keys: string[];
  optional_question_ids: string[];
  optional_question_keys: string[];
  unit_keys: string[];
  source_refs: SourceRef[];
  shared_unit_keys: string[];
  depends_on_shard_ids: Id[];
  budget_estimate_id: Id;
  omission_ids: Id[];
  state_hash: Hash | null;
  request_binding_id: Id | null;
  status: ShardStatus;
  reason_codes: string[];
}

export type OmissionReason =
  | "not_required"
  | "dedup_same_content"
  | "budget_context"
  | "budget_exceeds"
  | "limits_unknown"
  | "outside_scope"
  | "unretrievable"
  | "template_filtered"
  | "retrieval_gap"
  /** The shard was settled by verified hard facts instead of a dispatch. */
  | "deterministic_skip";

export interface Omission {
  schema_version: "rsi.evidence_omission/1";
  omission_id: Id;
  omission_key: Hash;
  shard_plan_id: Id;
  plan_hash: Hash;
  shard_id?: Id;
  question_ids: string[];
  question_keys: string[];
  unit_keys: Hash[];
  source_ids: string[];
  source_refs: SourceRef[];
  plan_omission_impact: "answer_changing" | "none";
  can_omit: boolean;
  required_for_issue: boolean;
  reason: OmissionReason;
  impact: "none" | "may_change_answer" | "blocking";
  recoverable: boolean;
  recorded_by: string;
  created_at: number;
}

export type ShardPlanState =
  | "planned"
  | "partially_rejected"
  | "bound"
  | "dispatched"
  | "completed"
  | "rejected";

export interface ShardPlan {
  schema_version: "rsi.shard_plan/1";
  shard_plan_id: Id;
  shard_plan_key: Hash;
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  pack_id: Id;
  pack_key: Hash;
  binding: VersionBinding;
  service_profile_id: Id;
  service_profile_key: Hash;
  compiler_version: string;
  counting_method_version: string;
  shard_policy_version: string;
  shard_order: Id[];
  shards: Shard[];
  omissions: Omission[];
  shard_plan_hash: Hash;
  state: ShardPlanState;
  dispatch_policy: "per_shard/1";
  created_at: number;
}

/* ------------------------------------------------------------------ */
/* Judge binding / answers / envelope                                  */
/* ------------------------------------------------------------------ */

export interface TemplateBinding {
  question_key: string;
  template_id: string;
  template_version: string;
  template_hash: Hash;
}

export interface QuestionBinding {
  question_id: string | null;
  question_key: string;
  template_id: string;
  template_version: string;
  template_hash: Hash;
  proposition_id: string;
  requirement_ids: string[];
  required_for_issue: boolean;
  option_order: string[];
  option_effects: Record<string, "supports" | "contradicts" | "unknown">;
  answer_to_issue_map: Record<string, ChoiceOptionMapping>;
  independence: PlannedQuestion["independence"];
}

export interface NoulPropositionBinding {
  schema_version: "rsi.noul_proposition_binding/1";
  binding_id: Id;
  question_key: string;
  proposition_id: string;
  requirement_ids: string[];
  p_yes_means: "proposition_true";
  inconsistent_equivalent: boolean;
  equivalence_source: "none" | "pre_registered_mapping";
  mapping_version: string;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type TypedJudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  p_yes: number;
  confidence: null;
  s: number | null;
  s_source: "none" | "noul_p_yes_explicit_inconsistent_equivalent";
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence_reported: number;
  confidence_recomputed: number;
  confidence_delta: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: string[];
  probabilities: Record<string, number>;
  confidence_reported: number;
  confidence_recomputed: null;
  confidence_delta: null;
  score_use: "shadow_only";
}

export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SemanticQuestionRequest {
  question_key: string;
  question_class:
    | "intent_relation"
    | "behavior_relation"
    | "step_effect"
    | "acceptance_relation"
    | "experience_match";
  instructions: string;
  options: Array<{ option_key: string; description: string }>;
  required_for_issue: boolean;
  proposition_id: string;
  requirement_ids: string[];
  evidence_refs: SourceRef[];
  template: { template_id: string; template_version: string; template_hash: Hash };
}

export interface JevTypedAdapterRequest {
  schema_version: "rsi.jev_typed_adapter_request/1";
  model: string;
  state: JudgeState;
  questions: Record<string, TypedJudgeQuestion>;
  adapter_contract_hash: Hash;
}

export interface SemanticBackendRequest {
  schema_version: "rsi.semantic_backend_request/1";
  request_id: Id;
  binding_id: Id;
  backend: SemanticBackendRef;
  method: MethodRef;
  scope: SemanticScope;
  pack: { pack_id: Id; pack_key: Hash; pack_hash: Hash };
  manifest: { manifest_id: Id; manifest_key: Hash; manifest_hash: Hash };
  state: {
    schema_version: "rsi.judge_state/2";
    state_ref: SourceRef;
    state_hash: Hash;
    state_content_hash: Hash;
    content_bytes: number;
  } | null;
  evidence: Array<{
    source_id: string;
    source_ref: SourceRef;
    excerpt: string;
    content_hash: Hash;
    roles: string[];
  }>;
  questions: SemanticQuestionRequest[];
  question_set_hash: Hash;
  evidence_set_hash: Hash;
  deadline_ms: number;
  budget_ref: SourceRef;
  authorization_ref: SourceRef | null;
  adapter_request: JevTypedAdapterRequest | null;
  created_at: number;
}

export interface JudgeRequestBindingV3 {
  schema_version: "rsi.judge_request_binding/3";
  binding_id: Id;
  request_id: Id;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  pack_id: Id;
  pack_hash: Hash;
  binding: VersionBinding;
  backend: SemanticBackendRef;
  request_schema_version: "rsi.semantic_backend_request/1";
  service_profile_id: Id | null;
  service_profile_key: Hash;
  validator_binding_id: Id;
  validator_binding_key: Hash;
  template_bindings: TemplateBinding[];
  template_bindings_digest: Hash;
  question_bindings: QuestionBinding[];
  question_bindings_digest: Hash;
  proposition_bindings_digest: Hash;
  request: SemanticBackendRequest;
  question_set_hash: Hash;
  evidence_set_hash: Hash;
  adapter_contract_hash: Hash | null;
  request_hash: Hash;
  dispatch_key: Hash;
  created_at: number;
}

export interface SemanticOutcome {
  effect: "supports" | "contradicts" | "unknown" | "not_applicable" | "shadow_only";
  mapped_from: "categorical_option";
  option_key: string | null;
  evidence_refs: SourceRef[];
  counterevidence_refs: SourceRef[];
  hard_effect: null;
}

export interface SemanticUsageObservation {
  elapsed_ms: number;
  cpu_ms: number | null;
  read_bytes: number;
  retrieval_count: number;
  model_invocations: number;
  verifier_invocations: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: "known" | "unknown" | "not_applicable";
  usage_source: "backend_reported" | "local_meter" | "none";
  receipt_ref: SourceRef | null;
}

export interface JevAdapterEvidence {
  kind: "jev_typed";
  schema_version: "rsi.jev_adapter_evidence/1";
  service_profile_key: Hash;
  provider: "typesafe" | "openrouter";
  route: string;
  requested_model: string;
  returned_model: string;
  model_match: "exact" | "alias" | "mismatch";
  validator_version: "rsi.judge.validator/1";
  validator_binding_key: Hash;
  http: {
    status_code: number;
    started_at: number;
    received_at: number;
    latency_ms: number;
    response_bytes: number;
  };
  wire: { response_hash: Hash; extra_keys: string[] };
  typed_answers: Record<string, JudgeAnswer>;
  applied_answers: Record<string, JudgeAnswer>;
  typed_mapped_from: Record<string, "choice" | "noul" | "score">;
  jev_validation: {
    status: "accepted" | "degraded";
    policy_version: "rsi.judge.validator/1";
    validator_binding_key: Hash;
    errors: string[];
    skipped_by_dependency: string[];
    primary_error: string | null;
    calibration_status: "not_applicable" | "eligible" | "invalidated";
  };
}

export interface LocalClassifierAdapterEvidence {
  kind: "local_classifier";
  schema_version: "rsi.local_classifier_adapter_evidence/1";
  implementation_id: string;
  implementation_version: string;
  raw_output_hash: Hash;
  deterministic: true;
  process_isolated: true;
}

type SemanticAdapterEvidence = JevAdapterEvidence | LocalClassifierAdapterEvidence;

export interface JudgeEnvelopeV2 {
  schema_version: "rsi.judge_envelope/2";
  envelope_id: Id;
  envelope_key: Hash;
  binding_id: Id;
  request_id: Id;
  request_hash: Hash;
  dispatch_key: Hash;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  pack_id: Id;
  pack_hash: Hash;
  binding: VersionBinding;
  service_profile_id: Id;
  service_profile_key: Hash;
  provider: "typesafe" | "openrouter";
  route: string;
  requested_model: string;
  returned_model: string;
  model_match: "exact" | "alias" | "mismatch";
  validator_version: "rsi.judge.validator/1";
  template_bindings: TemplateBinding[];
  question_bindings: QuestionBinding[];
  question_bindings_digest: Hash;
  http: {
    status_code: number;
    attempt_id: Id;
    started_at: number;
    received_at: number;
    latency_ms: number;
    response_bytes: number;
  };
  usage: { input_tokens?: number; output_tokens?: number } | null;
  wire: { response_hash: Hash; extra_keys: string[] };
  answers: Record<string, JudgeAnswer>;
  applied_answers: Record<string, JudgeAnswer>;
  semantic_outcomes: Record<
    string,
    {
      effect: "supports" | "contradicts" | "unknown" | "not_applicable" | "shadow_only";
      mapped_from: "choice" | "noul" | "score";
      hard_effect: null;
    }
  >;
  validation: {
    status: "accepted" | "degraded";
    policy_version: "rsi.judge.validator/1";
    validator_binding_id: Id;
    validator_binding_key: Hash;
    errors: string[];
    skipped_by_dependency: string[];
    primary_error: string | null;
    per_answer: Record<string, { status: "accepted" | "degraded"; errors: string[] }>;
    calibration_status: "not_applicable" | "eligible" | "invalidated";
  };
  received_at: number;
  envelope_hash: Hash;
}

export interface JudgeEnvelopeV3 {
  schema_version: "rsi.judge_envelope/3";
  envelope_id: Id;
  envelope_key: Hash;
  binding_id: Id;
  request_id: Id;
  request_hash: Hash;
  dispatch_key: Hash;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  pack_id: Id;
  pack_hash: Hash;
  binding: VersionBinding;
  backend: SemanticBackendRef;
  request_schema_version: "rsi.semantic_backend_request/1";
  question_set_hash: Hash;
  question_bindings_digest: Hash;
  template_bindings: TemplateBinding[];
  semantic_outcomes: Record<string, SemanticOutcome>;
  validation: {
    status: "accepted" | "degraded";
    policy_version: "rsi.semantic.validator/1";
    policy_hash: Hash;
    validator_binding_key: Hash;
    output_contract: "categorical_option/1";
    contract_hash: Hash;
    errors: string[];
    skipped_by_dependency: string[];
    primary_error: string | null;
    per_question: Record<string, { status: "accepted" | "degraded" | "missing"; errors: string[] }>;
    calibration_status: "not_applicable" | "eligible" | "invalidated";
  };
  adapter_evidence: SemanticAdapterEvidence | null;
  usage: SemanticUsageObservation;
  received_at: number;
  envelope_hash: Hash;
}

/* ------------------------------------------------------------------ */
/* Attempts / late results                                             */
/* ------------------------------------------------------------------ */

type JudgeAttemptState =
  | "prepared"
  | "sending"
  | "response_received"
  | "accepted"
  | "degraded"
  | "transport_error"
  | "timeout"
  | "outcome_unknown"
  | "cancelled";

export interface JudgeAttempt {
  schema_version: "rsi.judge_attempt/1";
  attempt_id: Id;
  attempt_key: Hash;
  binding_id: Id;
  request_id: Id;
  dispatch_key: Hash;
  attempt_no: number;
  state: JudgeAttemptState;
  started_at: number | null;
  finished_at: number | null;
  deadline_at_monotonic_ms: number;
  http_status: number | null;
  error_code: string | null;
  retryable: boolean;
  response_envelope_id: Id | null;
  late_result_id: Id | null;
  created_at: number;
}

export interface AttemptUsageObservation {
  elapsed_ms: number;
  cpu_ms: number | null;
  read_bytes: number;
  retrieval_count: number;
  model_invocations: number;
  verifier_invocations: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  cost_status: "known" | "unknown" | "not_applicable";
  usage_source: "backend_reported" | "local_meter" | "none";
  receipt_key: Hash | null;
}

export interface JudgeAttemptV2 {
  schema_version: "rsi.judge_attempt/2";
  attempt_id: Id;
  attempt_key: Hash;
  binding_id: Id;
  request_id: Id;
  dispatch_key: Hash;
  attempt_no: number;
  backend_kind: JevBackendKind;
  capability_key: Hash;
  capability_hash: Hash;
  method: MethodRef;
  scope_key: Hash;
  request_schema_version: "rsi.semantic_backend_request/1";
  validator_binding_key: Hash;
  state: JudgeAttemptState;
  started_at: number | null;
  finished_at: number | null;
  deadline_at_monotonic_ms: number;
  http_status: number | null;
  error_code: string | null;
  retryable: boolean;
  response_envelope_id: Id | null;
  response_envelope_schema_version: "rsi.judge_envelope/3" | null;
  late_result_id: Id | null;
  late_result_schema_version: "rsi.late_judge_result/2" | null;
  usage: AttemptUsageObservation;
  created_at: number;
}

export interface LateResultSubmission {
  schema_version: "rsi.late_result_submission/1";
  attempt_id: Id;
  binding_id: Id;
  request_hash: Hash;
  envelope: JudgeEnvelopeV2 | null;
  raw_response_hash: Hash;
  received_at: number;
}

export interface LateResultSubmissionV2 {
  schema_version: "rsi.late_result_submission/2";
  attempt_id: Id;
  binding_id: Id;
  request_hash: Hash;
  capability_key: Hash;
  envelope_schema_version: "rsi.judge_envelope/3" | null;
  envelope: JudgeEnvelopeV3 | null;
  raw_response_hash: Hash;
  received_at: number;
}

type LateDurableDisposition = "appended_history" | "conflict_rejected";
export type LateDisposition = "appended_history" | "idempotent_noop" | "conflict_rejected";

export interface LateJudgeResult {
  schema_version: "rsi.late_judge_result/1";
  late_result_id: Id;
  late_result_key: Hash;
  attempt_id: Id;
  binding_id: Id;
  request_hash: Hash;
  envelope: JudgeEnvelopeV2 | null;
  raw_response_hash: Hash;
  received_at: number;
  disposition: LateDurableDisposition;
}

export interface LateJudgeResultV2 {
  schema_version: "rsi.late_judge_result/2";
  late_result_id: Id;
  late_result_key: Hash;
  attempt_id: Id;
  binding_id: Id;
  request_hash: Hash;
  capability_key: Hash;
  envelope_schema_version: "rsi.judge_envelope/3" | null;
  envelope: JudgeEnvelopeV3 | null;
  raw_response_hash: Hash;
  received_at: number;
  disposition: LateDurableDisposition;
}

export interface LateResultReceipt {
  disposition: LateDisposition;
  late_result_id: Id;
  wrote: boolean;
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

export interface AggregateShardExpectation {
  shard_id: Id;
  shard_key: Hash;
  question_keys: string[];
  required_for_issue: boolean;
  expected_request_hash: Hash | null;
  expected_dispatch_key: Hash | null;
  binding_status: ShardStatus;
  /**
   * The shard row's `reason_codes`.
   *
   * DD-EVD-021: a shard that never reached the backend records the semantic
   * failure code here (`E_SEMANTIC_BACKEND_UNKNOWN`,
   * `E_SEMANTIC_SCOPE_UNSUPPORTED`, `E_SEMANTIC_CONTRACT_UNSUPPORTING` or
   * `E_SEMANTIC_OUTPUT_INVALID`); DD-EVD-022A maps those codes onto the
   * matching `AggregateMissingV2.kind`.
   */
  reason_codes?: string[];
}

interface HardFactSnapshotInput {
  snapshot_hash: Hash;
  binding: VersionBinding;
  watermark: number;
  scope: "ledger_scan/1";
  hard_fact_view_hash: Hash;
}

export interface AggregateInput {
  issue_id: Id;
  issue_key: string;
  plan_id: Id;
  plan_hash: Hash;
  plan_state: QuestionPlan["plan_state"];
  state_profile: StateProfile;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  pack_id: Id;
  pack_key: Hash;
  pack_hash: Hash;
  version_binding: VersionBinding;
  question_bindings: QuestionBinding[];
  question_bindings_digest: Hash;
  validator_binding_key: Hash;
  shard_expectations: AggregateShardExpectation[];
  envelope_ids: Id[];
  omission_ids: Id[];
  hard_fact_snapshot: HardFactSnapshotInput;
  hard_fact_keys: Hash[];
  aggregation_policy_version: "rsi.aggregate/1";
  created_at: number;
}

export interface AggregateInputV2 extends Omit<
  AggregateInput,
  "aggregation_policy_version" | "envelope_ids"
> {
  aggregation_policy_version: "rsi.aggregate/2";
  review_policy_version: "rsi.aggregate.review/1";
  backend: SemanticBackendRef;
  validator_policy_version: "rsi.semantic.validator/1";
  envelope_ids: Id[];
  legacy_envelope_ids: Id[];
  /**
   * The shard keys that carry only a legacy `/2` envelope.
   *
   * DD-EVD-022A: a `/2` envelope never fills the current aggregate; its
   * shard's questions enter `stale_discarded` with reason `legacy_envelope`
   * and count as missing.
   */
  legacy_envelope_shard_keys?: Hash[];
  /**
   * Questions the deterministic dispatch layer settled from verified hard
   * facts before shard planning. A key is only honoured when the existing
   * hard facts give every required proposition a clean decision; otherwise
   * it is ignored and the question keeps its normal missing/coverage path.
   * Absence keeps the reducer's classic behaviour.
   */
  decided_question_keys?: string[];
}

export interface AggregateShardSelection {
  shard_id: Id;
  shard_key: Hash;
  request_hash: Hash;
  dispatch_key: Hash;
  envelope_id: Id | null;
  envelope_key: Hash | null;
  attempt_id: Id | null;
  validation_status: "accepted" | "degraded" | "missing" | "stale";
  model_match: "exact" | "alias" | "mismatch" | null;
  selected: boolean;
  reason_codes: string[];
}

export interface AggregateShardSelectionV2 extends AggregateShardSelection {
  envelope_schema_version: "rsi.judge_envelope/3" | null;
  capability_key: Hash | null;
  capability_hash: Hash | null;
}

export interface AggregateCoverage {
  required_question_keys: string[];
  accepted_question_keys: string[];
  degraded_question_keys: string[];
  missing_question_keys: string[];
  stale_question_keys: string[];
  budget_rejected_question_keys: string[];
  projection_rejected_question_keys: string[];
  complete: boolean;
}

export interface PropositionAggregate {
  proposition_id: string;
  requirement_ids: string[];
  question_keys: string[];
  semantic_effects: {
    supports: string[];
    contradicts: string[];
    unknown: string[];
    not_applicable: string[];
  };
  hard_effects: { supports: Hash[]; violates: Hash[] };
  result:
    | "supported_hard"
    | "supported_semantic"
    | "contradicted_hard"
    | "contradicted_semantic"
    | "conflict"
    | "unknown"
    | "missing";
  resolved_by: "none" | "hard_support" | "hard_violation";
  evidence_refs: SourceRef[];
}

export interface RequirementAggregate {
  requirement_id: string;
  proposition_ids: string[];
  hard_effects: {
    supports: Hash[];
    violates: Hash[];
    same_source_conflicts: Hash[];
  };
  final_state: FinalState;
  basis: FinalBasis;
  reason_codes: string[];
}

export interface AggregateConflict {
  conflict_key: Hash;
  proposition_id: string;
  requirement_ids: string[];
  sides: Array<{
    question_key: string;
    envelope_key: Hash;
    effect: "supports" | "contradicts";
  }>;
  resolution: "unresolved" | "resolved_hard_support" | "resolved_hard_violation";
  reason_codes: string[];
}

type AggregateMissingKind =
  | "missing_shard"
  | "budget_rejected"
  | "projection_rejected"
  | "degraded"
  | "stale"
  | "no_answer"
  | "service_unknown"
  | "transport_unknown"
  | "optional_missing";

export interface AggregateMissing {
  question_key: string;
  shard_key: Hash | null;
  kind: AggregateMissingKind;
  required_for_issue: boolean;
  recoverable: boolean;
  omission_keys: Hash[];
  source_refs: SourceRef[];
}

export interface AggregateMissingV2 extends Omit<AggregateMissing, "kind"> {
  kind:
    | AggregateMissingKind
    | "backend_unknown"
    | "scope_unsupported"
    | "contract_unsupported"
    | "output_invalid";
}

type AggregateStaleReason =
  | "version_mismatch"
  | "pack_mismatch"
  | "request_mismatch"
  | "dispatch_mismatch"
  | "shard_mismatch"
  | "validator_mismatch"
  | "future_watermark";

export interface AggregateStale {
  question_key: string;
  shard_key: Hash;
  rejected_binding: VersionBinding;
  current_binding: VersionBinding;
  reason: AggregateStaleReason;
}

export interface AggregateStaleV2 extends Omit<AggregateStale, "reason"> {
  reason: AggregateStaleReason | "capability_mismatch" | "contract_mismatch" | "legacy_envelope";
}

export interface HardFactUse {
  fact_key: Hash;
  independence_key: Hash;
  requirement_id: string;
  proposition_id?: string;
  effect: "supports" | "violates";
  verified: true;
  artifact_version?: string;
  source_ids: string[];
  source_refs: SourceRef[];
}

export interface OptionalObservation {
  question_key: string;
  envelope_key: Hash;
  effect: "supports" | "contradicts" | "unknown" | "not_applicable";
  issue_effect: ChoiceOptionMapping["issue_effect"] | null;
  affects_final_state: false;
  local_action_authorized: false;
}

type FinalState = "consistent" | "inconsistent" | "unknown" | "abstain" | "needs_evidence";
type FinalBasis = "hard_fact" | "semantic_shadow" | "mixed" | null;

export interface AggregateInputKeys {
  pack_hash: Hash;
  shard_plan_key: Hash;
  selected_envelope_keys: Hash[];
  hard_fact_keys: Hash[];
  omission_keys: Hash[];
  question_bindings_digest: Hash;
  hard_fact_snapshot_hash: Hash;
  hard_fact_view_hash: Hash;
}

export interface AnswerAggregate {
  schema_version: "rsi.answer_aggregate/1";
  aggregate_id: Id;
  aggregate_key: Hash;
  issue_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  binding: VersionBinding;
  aggregation_policy_version: "rsi.aggregate/1";
  validator_policy_version: "rsi.judge.validator/1";
  validator_binding_id: Id;
  validator_binding_key: Hash;
  selected_shards: AggregateShardSelection[];
  coverage: AggregateCoverage;
  propositions: PropositionAggregate[];
  requirements: RequirementAggregate[];
  conflicts: AggregateConflict[];
  missing: AggregateMissing[];
  stale_discarded: AggregateStale[];
  hard_facts: HardFactUse[];
  optional_observations: OptionalObservation[];
  final_state: FinalState;
  final_basis: FinalBasis;
  reason_codes: string[];
  coverage_complete: boolean;
  task_success: false;
  delivery_allowed: false;
  local_action: "record_only" | "request_evidence" | "request_human_review" | "notify_hard_fact";
  evidence_refs: SourceRef[];
  input_keys: AggregateInputKeys;
  created_at: number;
  aggregate_hash: Hash;
  supersedes_aggregate_id?: Id;
}

export interface AnswerAggregateV2 extends Omit<
  AnswerAggregate,
  | "schema_version"
  | "aggregation_policy_version"
  | "validator_policy_version"
  | "selected_shards"
  | "missing"
  | "stale_discarded"
  | "local_action"
  | "input_keys"
> {
  schema_version: "rsi.answer_aggregate/2";
  aggregation_policy_version: "rsi.aggregate/2";
  review_policy_version: "rsi.aggregate.review/1";
  validator_policy_version: "rsi.semantic.validator/1";
  backend: SemanticBackendRef;
  selected_shards: AggregateShardSelectionV2[];
  missing: AggregateMissingV2[];
  stale_discarded: AggregateStaleV2[];
  local_action: "record_only" | "request_evidence" | "notify_hard_fact";
  human_review_candidate: boolean;
  human_review_reasons: Array<
    "hard_fact_conflict" | "irrecoverable_evidence" | "semantic_conflict" | "semantic_unknown"
  >;
  input_keys: AggregateInputKeys & { capability_key: Hash; capability_hash: Hash };
}

export interface AggregateRequest {
  issue_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  current_binding: VersionBinding;
  frozen_snapshot: EvidenceIndexSnapshot;
  aggregation_policy_version: "rsi.aggregate/1";
}

export interface AggregateRequestV2 {
  issue_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  current_binding: VersionBinding;
  frozen_snapshot: EvidenceIndexSnapshot;
  aggregation_policy_version: "rsi.aggregate/2";
  review_policy_version: "rsi.aggregate.review/1";
  /**
   * Explicit semantic validator identity for aggregations that carry no
   * request binding (a shard the deterministic short-circuit never
   * dispatched). It is never defaulted: without a binding and without this
   * field the aggregate is refused with `E_VALIDATOR_BINDING_MISSING`.
   * When request bindings exist the persisted key is authoritative and an
   * explicit key must agree with it.
   */
  validator_binding_key?: Hash;
  /**
   * Explicit question-set digest. It is only needed when no request binding
   * exists; the aggregator otherwise uses the persisted digest, and falls
   * back to `questionBindingsDigest(plan.questions)` as the last resort.
   */
  question_bindings_digest?: Hash;
  /**
   * Questions the caller's deterministic dispatch settled from verified hard
   * facts. The aggregator re-validates every key against the frozen hard-fact
   * set; an unproven key is ignored. Absence keeps the classic behaviour.
   */
  decided_question_keys?: readonly string[];
}

export interface AnswerAggregator {
  aggregate(input: AggregateRequestV2): Promise<Result<AnswerAggregateV2, EvdError>>;
}

export interface EvdStateReadPort {
  readEvdAggregateSnapshot(q: {
    binding: VersionBinding;
    shard_plan_key: Hash;
  }): Promise<Result<EvdAggregateInputs, ErrorEnvelope>>;
  readValidatorBinding(q: {
    validator_binding_key: Hash;
  }): Promise<Result<EvdValidatorBindingRow | null, ErrorEnvelope>>;
  readEvdAcceptedAggregate(q: {
    aggregate_id: Id;
    task_id: Id;
    branch_id: Id;
    input_epoch: number;
    goal_version: string;
    config_version: string;
  }): Promise<Result<EvdAcceptedAggregateRead | null, ErrorEnvelope>>;
}

export interface AnswerAggregatorDeps {
  plans: PlanReadPort;
  state: EvdStateReadPort;
  now: () => number;
}

export interface AcceptedAggregateReadRequest {
  aggregate_id: Id;
  expected_aggregate_hash: Hash;
  issue_id: Id;
  plan_id: Id;
  plan_hash: Hash;
  binding: VersionBinding;
}

export interface AcceptedAggregateReadPort {
  readAccepted(
    input: AcceptedAggregateReadRequest
  ): Promise<Result<AnswerAggregate | AnswerAggregateV2, EvdError>>;
}

export interface AcceptedAggregateReaderDeps {
  aggregates: EvdStateReadPort;
}

/* ------------------------------------------------------------------ */
/* Compiler inputs (DD-EVD-026)                                        */
/* ------------------------------------------------------------------ */

export interface PackCompileInput {
  schema_version: "rsi.pack_compile_input/1";
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  issue_key: string;
  binding: VersionBinding;
  snapshot: EvidenceIndexSnapshot;
  service_profile_key: Hash;
  limits: RunBudget;
  compiler_version: string;
  counting_method_version: string;
}

export interface CompiledPack {
  schema_version: "rsi.compiled_pack/1";
  pack: EvidencePack;
  units: DependencyUnit[];
  manifests: JudgeStateManifest[];
}

export interface ClosureInput {
  schema_version: "rsi.closure_input/1";
  plan_id: Id;
  plan_hash: Hash;
  pack_key: Hash;
  required_question_keys: string[];
  optional_question_keys: string[];
  units: DependencyUnit[];
  limits: RunBudget;
}

export interface ClosureResult {
  schema_version: "rsi.closure_result/1";
  units: DependencyUnit[];
  omissions: Omission[];
  per_question: Array<{ question_key: string; unit_keys: string[]; omission_keys: string[] }>;
  closure_hash: Hash;
}

export interface ShardPlanInput {
  schema_version: "rsi.shard_plan_input/1";
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  issue_key: string;
  pack: EvidencePack;
  pack_key: Hash;
  closure: ClosureResult;
  snapshot: EvidenceIndexSnapshot;
  service_profile: JevServiceProfile | SemanticBackendCapability;
  limits: RunBudget;
  binding: VersionBinding;
  shard_policy_version: "per_shard/1";
}

export interface PlannedShards {
  schema_version: "rsi.planned_shards/1";
  plan: ShardPlan;
  shards: Shard[];
  estimates: Array<BudgetEstimate | SemanticBudgetEstimate>;
  omissions: Omission[];
  /**
   * Shard-local JudgeState projections, one per non-rejected shard, sorted by
   * `shard_key`. Each entry carries the persisted `Shard.shard_id` and
   * `Shard.shard_key`; this is the only manifest set `commitCompile` accepts,
   * because a manifest built before binning cannot name its shard.
   */
  manifests: JudgeStateManifest[];
  /**
   * The exact `JudgeState/2` projection each manifest hashes, keyed by the
   * persisted shard id. The compile writer stores these as immutable
   * `object_document` rows so the binding reader can resolve `state_hash`
   * before the first request binding exists.
   */
  judge_states?: Array<{ shard_id: Id; state: JsonValue }>;
  state: ShardPlanState;
  reason_code: string | null;
  /**
   * Outer commit disposition of the `planShards` write. `planShardsForPlan`
   * is the pure planner, so a successful return is always a fresh commit.
   */
  commit_state?: "committed" | "existing";
}

export interface BindingInput {
  invocation_id: Id;
  request_binding_id?: Id;
  plan_id: Id;
  plan_hash: Hash;
  question_ids: string[];
  version_binding: VersionBinding;
  pack_id: Id;
  pack_key: Hash;
  shard_plan_id: Id;
  shard_id: Id;
  backend: SemanticBackendRef;
  service_profile_id: Id | null;
  template_bindings: TemplateBinding[];
  validator_binding_id: Id;
  budget: RunBudget;
  deadline_at_monotonic_ms: number;
  created_at: number;
}

export interface EvidenceCompiler {
  compilePack(input: PackCompileInput): Promise<Result<CompiledPack, EvdError>>;
  expandClosure(input: ClosureInput): Result<ClosureResult, EvdError>;
  planShards(input: ShardPlanInput): Promise<Result<PlannedShards, EvdError>>;
  estimateBudget(input: BudgetInput): Result<BudgetEstimate, EvdError>;
  estimateSemanticBudget(input: SemanticBudgetInput): Result<SemanticBudgetEstimate, EvdError>;
  buildRequest(input: BindingInput): Promise<Result<JudgeRequestBindingV3, EvdError>>;
}

/* ------------------------------------------------------------------ */
/* Judge service                                                       */
/* ------------------------------------------------------------------ */

export interface EvidenceInput {
  source_id: string;
  source_ref?: SourceRef;
  excerpt: string;
  content_hash: Hash;
  artifact_version?: string;
  inseparable_group_key: string;
  roles: Array<
    "requirement" | "counter" | "context" | "artifact" | "verifier" | "feedback" | "history"
  >;
}

interface JudgeInvocation {
  invocation_id: Id;
  purpose: "issue_progress" | "experience_match";
  plan_id: Id;
  plan_hash: Hash;
  question_ids: string[];
  version_binding: VersionBinding;
  issue_id: Id;
  template_bindings: TemplateBinding[];
  backend: SemanticBackendRef;
  service_profile_id: Id | null;
  budget: RunBudget;
  pack_id?: Id;
  binding_id?: Id;
  evidence?: EvidenceInput[];
  allow_shadow?: boolean;
}

export interface JudgeInvocationResult {
  invocation_id: Id;
  status: "accepted" | "degraded" | "rejected" | "unknown" | "cancelled";
  envelope_id: Id | null;
  envelope_key: Hash | null;
  binding_id: Id | null;
  request_hash: Hash | null;
  dispatch_key: Hash | null;
  attempt_id: Id | null;
  service_profile_id: Id | null;
  validator_binding_id: Id | null;
  validator_binding_key: Hash | null;
  validator_version: string | null;
  template_bindings: TemplateBinding[];
  template_bindings_digest: Hash | null;
  question_bindings_digest: Hash | null;
  applied_answers: Record<string, JudgeAnswer>;
  semantic: Record<
    string,
    "supports" | "contradicts" | "unknown" | "not_applicable" | "shadow_only"
  >;
  candidate_disposition: "unverified" | null;
  errors: string[];
  primary_error: string | null;
  retryable: boolean;
  task_success: false;
}

export interface ExperienceMatchJudgeInput extends JudgeInvocation {
  purpose: "experience_match";
  question: TypedJudgeQuestion;
  options: string[];
  proposed_evidence_refs: SourceRef[];
}

export interface ExperienceMatchJudgeResult extends JudgeInvocationResult {
  purpose: "experience_match";
  match_outcome: "applicable" | "conflict" | "unknown" | "not_applicable" | null;
  proposal_disposition: "unverified";
}

export interface JudgeService {
  judge(input: JudgeInvocation): Promise<JudgeInvocationResult>;
  judgeExperienceMatch(input: ExperienceMatchJudgeInput): Promise<ExperienceMatchJudgeResult>;
  recordLateResult(
    input: LateResultSubmissionV2
  ): Promise<Result<LateResultReceipt, EvdError>>;
}

export type SemanticBackendTransportOutcome =
  | { status: "response"; http_status: number; received_at: number; raw_body: unknown }
  | {
      status: "transport_error";
      error_code: string;
      retryable: boolean;
      received_at: number;
    }
  | { status: "timeout"; received_at: number }
  | { status: "cancelled"; received_at: number }
  | { status: "outcome_unknown"; error_code: string; received_at: number };

export interface SemanticBackendPort {
  invoke(input: {
    request: SemanticBackendRequest;
    signal: AbortSignal;
  }): Promise<SemanticBackendTransportOutcome>;
}

export interface JudgeGateway {
  dispatch(
    binding: JudgeRequestBindingV3,
    budget: RunBudget,
    signal: AbortSignal
  ): Promise<JudgeAttemptResult>;
  acceptResponse(
    binding: JudgeRequestBindingV3,
    attempt: JudgeAttemptV2,
    wire: unknown
  ): Result<JudgeEnvelopeV3, EvdError>;
  recordLateResult(
    input: LateResultSubmissionV2
  ): Promise<Result<LateResultReceipt, EvdError>>;
}

export type JudgeAttemptResult =
  | { status: "accepted"; attempt: JudgeAttemptV2; envelope: JudgeEnvelopeV3 }
  | { status: "degraded"; attempt: JudgeAttemptV2; envelope: JudgeEnvelopeV3 }
  | { status: "rejected"; attempt: JudgeAttemptV2 | null; error: EvdError }
  | { status: "unknown"; attempt: JudgeAttemptV2; error: EvdError }
  | { status: "cancelled"; attempt: JudgeAttemptV2; error: EvdError }
  | { status: "late_result_appended"; attempt: JudgeAttemptV2; late_result_id: Id };

/* ------------------------------------------------------------------ */
/* Persistence rows (DD-EVD-024)                                       */
/* ------------------------------------------------------------------ */

interface EvdBoundRow {
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  watermark: number;
}

interface EvdRowAudit {
  row_version: number;
  created_at: number;
}

export interface EvdContentMeta {
  content_hash: Hash;
  content_ref: SourceRef;
  content_bytes: number;
  source_blob_refs: SourceRef[];
}

export interface EvdEvidencePackRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  pack_id: Id;
  pack_key: Hash;
  pack_hash: Hash;
  evidence_hash: Hash;
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  issue_key: string;
  pack_state: "valid" | "invalidated";
}

export interface EvdDependencyUnitRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  unit_id: Id;
  unit_key: Hash;
  unit_hash: Hash;
  plan_id: Id;
  plan_hash: Hash;
  pack_id: Id;
  pack_key: Hash;
  dependency_key: string;
  inseparable_group_key: string;
  transport_role: DependencyUnit["transport_role"];
}

export interface EvdStateManifestRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  manifest_id: Id;
  manifest_key: Hash;
  manifest_hash: Hash;
  shard_id: Id;
  shard_key: Hash;
  plan_id: Id;
  plan_hash: Hash;
  pack_key: Hash;
  state_hash: Hash;
  state_content_hash: Hash;
}

export interface EvdShardPlanRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  shard_plan_id: Id;
  shard_plan_key: Hash;
  shard_plan_hash: Hash;
  plan_id: Id;
  plan_hash: Hash;
  issue_id: Id;
  pack_id: Id;
  pack_key: Hash;
  service_profile_id: Id;
  service_profile_key: Hash;
  state: ShardPlanState;
}

export interface EvdShardRow extends EvdBoundRow, EvdRowAudit {
  shard_id: Id;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  shard_key: Hash;
  shard_order: number;
  status: ShardStatus;
  request_binding_id: Id | null;
  attempt_ids: Id[];
  envelope_keys: Hash[];
  reason_codes: string[];
  body_json: Shard;
}

export interface EvdOmissionRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  omission_id: Id;
  omission_key: Hash;
  shard_plan_id: Id;
  plan_hash: Hash;
  shard_id: Id | null;
  question_keys: string[];
  unit_keys: Hash[];
  impact: Omission["impact"];
  reason: OmissionReason;
  required_for_issue: boolean;
  recoverable: boolean;
}

export interface EvdBudgetEstimateRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  estimate_id: Id;
  estimate_key: Hash;
  estimate_hash: Hash;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  service_profile_key: Hash;
  limits_hash: Hash;
  verdict: BudgetEstimate["verdict"] | SemanticBudgetEstimate["verdict"];
}

export interface EvdServiceProfileRow extends EvdRowAudit {
  profile_id: Id;
  profile_key: Hash;
  profile_version: number;
  acceptance_status: "eligible" | "shadow_only" | "blocked";
  production_use: boolean;
  body_json: JevServiceProfile | SemanticBackendCapability;
}

export interface EvdServiceStateRow extends EvdRowAudit {
  service_state_key: Hash;
  profile_key: Hash;
  current_profile_version: number;
  current_profile_id: Id;
  acceptance_status: JevServiceState["acceptance_status"];
  reason_codes: string[];
  body_json: JevServiceState;
}

export interface EvdValidatorBindingRow extends EvdRowAudit {
  validator_binding_id: Id;
  validator_binding_key: Hash;
  validator_policy_hash: Hash;
  service_profile_key: Hash;
  body_json: ValidatorBinding | SemanticValidationBinding;
}

export interface EvdRequestBindingRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  binding_id: Id;
  request_hash: Hash;
  dispatch_key: Hash;
  plan_id: Id;
  plan_hash: Hash;
  shard_id: Id;
  shard_key: Hash;
  shard_plan_id: Id;
  shard_plan_key: Hash;
  service_profile_key: Hash;
  validator_binding_key: Hash;
  state_hash: Hash;
  state_content_hash: Hash;
  questions_hash: Hash;
  template_bindings_digest: Hash;
  question_bindings_digest: Hash;
  proposition_bindings_digest: Hash;
}

export interface EvdAttemptRow extends EvdBoundRow, EvdRowAudit {
  attempt_id: Id;
  attempt_key: Hash;
  binding_id: Id;
  request_id: Id;
  dispatch_key: Hash;
  attempt_no: number;
  state: JudgeAttemptState;
  http_status: number | null;
  error_code: string | null;
  response_envelope_id: Id | null;
  late_result_id: Id | null;
  body_json: JudgeAttempt | JudgeAttemptV2;
}

export interface EvdEnvelopeRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  envelope_id: Id;
  envelope_key: Hash;
  binding_id: Id;
  attempt_id: Id;
  request_hash: Hash;
  dispatch_key: Hash;
  shard_id: Id;
  shard_key: Hash;
  validation_status: "accepted" | "degraded";
  received_at: number;
}

export interface EvdLateResultRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  late_result_id: Id;
  late_result_key: Hash;
  attempt_id: Id;
  envelope_key: Hash | null;
  disposition: LateDurableDisposition;
  received_at: number;
}

export interface EvdAggregateRow extends EvdBoundRow, EvdRowAudit, EvdContentMeta {
  aggregate_id: Id;
  aggregate_key: Hash;
  aggregate_hash: Hash;
  plan_hash: Hash;
  shard_plan_key: Hash;
  final_state: FinalState;
  final_basis: FinalBasis;
  coverage_complete: boolean;
  supersedes_aggregate_id: Id | null;
}

export interface EvdAggregateInputs {
  binding: VersionBinding;
  shard_plan: EvdShardPlanRow;
  pack: EvdEvidencePackRow;
  shards: EvdShardRow[];
  request_bindings: EvdRequestBindingRow[];
  attempts: EvdAttemptRow[];
  envelopes: EvdEnvelopeRow[];
  late_results: EvdLateResultRow[];
  omissions: EvdOmissionRow[];
  aggregates: EvdAggregateRow[];
}

export interface EvdAcceptedAggregateRead {
  row: EvdAggregateRow;
  content_bytes: Uint8Array;
}

export interface EvdStateWritePort {
  commitCompile(input: EvdCompileBatch): Promise<LiveCommitOutcome<null>>;
  commitBinding(input: {
    binding: VersionBinding;
    request_binding: JudgeRequestBindingV3;
    shard_id: Id;
    /**
     * Real `ShardPlan.shard_plan_key` of the plan that produced this shard.
     * Persisted on the request-binding row so readers can join the plan
     * without inventing a zero hash.
     */
    shard_plan_key: Hash;
    validator_binding_key: Hash;
  }): Promise<LiveCommitOutcome<null>>;
  prepareAttempt(input: {
    binding: VersionBinding;
    attempt: JudgeAttemptV2 | JudgeAttempt;
  }): Promise<LiveCommitOutcome<null>>;
  markSending(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
  }): Promise<LiveCommitOutcome<null>>;
  commitResponse(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
    envelope: JudgeEnvelopeV3 | JudgeEnvelopeV2;
    terminal_state: "accepted" | "degraded" | "transport_error" | "timeout" | "outcome_unknown";
  }): Promise<LiveCommitOutcome<null>>;
  /**
   * Commits an attempt transition that has no envelope row.
   *
   * `transport_error`, `timeout`, `outcome_unknown` and `cancelled` are real
   * terminal states; only `accepted`/`degraded` may carry an envelope. The
   * transition stays inside the existing `rsi.evd_attempt_row/1` journal ABI
   * and the frozen attempt state union.
   */
  commitAttemptTerminal(input: {
    binding: VersionBinding;
    attempt_id: Id;
    expected_row_version: number;
    attempt: JudgeAttemptV2;
  }): Promise<LiveCommitOutcome<null>>;
  commitAggregate(input: {
    binding: VersionBinding;
    aggregate: AnswerAggregateV2 | AnswerAggregate;
  }): Promise<LiveCommitOutcome<null>>;
  commitLate(input: {
    binding: VersionBinding;
    late: LateJudgeResultV2 | LateJudgeResult;
  }): Promise<LiveCommitOutcome<null>>;
  writeServiceProfile(input: {
    profile: Omit<JevServiceProfile, "profile_id" | "profile_version" | "created_at">;
    expected_previous_version: number | null;
  }): Promise<LiveCommitOutcome<null>>;
  writeSemanticBackendCapability(input: {
    capability: Omit<SemanticBackendCapability, "capability_hash"> & { capability_hash: Hash };
    expected_previous_version: number | null;
  }): Promise<LiveCommitOutcome<null>>;
  writeValidatorBinding(input: { binding: ValidatorBinding }): Promise<LiveCommitOutcome<null>>;
  writeSemanticValidationBinding(input: {
    binding: SemanticValidationBinding;
  }): Promise<LiveCommitOutcome<null>>;
}

export interface EvdCompileBatch {
  binding: VersionBinding;
  pack: EvidencePack;
  units: DependencyUnit[];
  manifests: JudgeStateManifest[];
  shard_plan: ShardPlan;
  shards: Shard[];
  omissions: Omission[];
  estimates: Array<BudgetEstimate | SemanticBudgetEstimate>;
  /** Projected states for the committed manifests, stored before the rows. */
  states?: Array<{ shard_id: string; state: JsonValue }>;
}

export type LiveCommitOutcome<T> =
  | { ok: true; commit_state: "committed"; value: T; receipt: unknown }
  | { ok: true; commit_state: "existing"; value: T | null }
  | {
      ok: false;
      commit_state: "not_written" | "unknown_recovery_required";
      error: ErrorEnvelope;
    };

/* ------------------------------------------------------------------ */
/* Errors (DD-EVD-026)                                                 */
/* ------------------------------------------------------------------ */

export type EvdOwnedErrorCode =
  | "E_INDEX_REQUEST_INVALID"
  | "E_INDEX_BINDING_INVALID"
  | "E_INDEX_WATERMARK_INVALID"
  | "E_INDEX_WINDOW_INVALID"
  | "E_INDEX_REVIEW_SNAPSHOT_INVALID"
  | "E_INDEX_REVIEW_SNAPSHOT_MISSING"
  | "E_INDEX_UPSTREAM_UNAVAILABLE"
  | "E_INDEX_PROGRESS_UNSUPPORTED"
  | "E_INDEX_SOURCE_UNRETRIEVABLE"
  | "E_INDEX_SOURCE_UTF8_INVALID"
  | "E_INDEX_SOURCE_HASH_MISMATCH"
  | "E_INDEX_SOURCE_CONFLICT"
  | "E_INDEX_SOURCE_TOO_LARGE"
  | "E_INDEX_LIMIT_EXCEEDED"
  | "E_INDEX_VERSION_CONFLICT"
  | "E_INDEX_DERIVATION_FAILED"
  | "E_INDEX_ABORTED"
  | "E_INDEX_SCOPE_MISMATCH"
  | "E_INDEX_SNAPSHOT_ID_MISMATCH"
  | "E_INDEX_NOT_LOADED"
  | "E_INDEX_DEADLINE_EXCEEDED"
  | "E_EVIDENCE_PACK_V1_READ_ONLY"
  | "E_BINDING_V1_READ_ONLY"
  | "E_EVIDENCE_PACK_STALE"
  | "E_EVIDENCE_CLOSURE_INCOMPLETE"
  | "E_EVIDENCE_INSEPARABLE_SPLIT"
  | "E_EVIDENCE_EXCEEDS_BUDGET"
  | "E_EVIDENCE_OMISSION_BINDING"
  | "E_EVIDENCE_LIMITS_UNKNOWN"
  | "E_EVIDENCE_PLAN_NOT_DISPATCHABLE"
  | "E_EVIDENCE_MANIFEST_MISMATCH"
  | "E_BUDGET_RESERVE_INCONSISTENT"
  | "E_PROJECTION_VIEW_MISSING"
  | "E_PROJECTION_SOURCE_MISSING"
  | "E_PROJECTION_OMISSION_BLOCKING"
  | "E_STATE_LOCAL_URI"
  | "E_STATE_VOLATILE_FIELD"
  | "E_STATE_WHOLE_TASK_SCOPE"
  | "E_STATE_VERSION_UNSUPPORTED"
  | "E_JUDGE_STATE_V1_READ_ONLY"
  | "E_WIRE_INVALID"
  | "E_ANSWER_SET"
  | "E_TYPE"
  | "E_NON_FINITE"
  | "E_PROBABILITY_KEYS"
  | "E_PROBABILITY_RANGE"
  | "E_PROBABILITY_SUM"
  | "E_CHOICE_OUT_OF_SET"
  | "E_UNKNOWN_OPTION"
  | "E_OPTION_COUNT"
  | "E_SCORE_LEVELS"
  | "E_CONFIDENCE_MISMATCH"
  | "E_MODEL_MISMATCH"
  | "E_UNSUPPORTED_QUESTION_TYPE"
  | "E_SERVICE_PROFILE_UNKNOWN"
  | "E_SERVICE_PROFILE_BLOCKED"
  | "E_SERVICE_PROFILE_MISMATCH"
  | "E_SEMANTIC_BACKEND_UNKNOWN"
  | "E_SEMANTIC_SCOPE_UNSUPPORTED"
  | "E_SEMANTIC_CONTRACT_UNSUPPORTED"
  | "E_SEMANTIC_OUTPUT_INVALID"
  | "E_SERVICE_UNAVAILABLE"
  | "E_RATE_LIMITED"
  | "E_HTTP_5XX"
  | "E_HTTP_4XX"
  | "E_OUTCOME_UNKNOWN"
  | "E_USAGE_ESTIMATE_UNDERFLOW"
  | "E_ATTEMPT_IN_FLIGHT"
  | "E_AGGREGATE_BINDING_INCOMPLETE"
  | "E_AGGREGATE_SNAPSHOT_MISMATCH"
  | "E_AGGREGATE_NO_PROPOSITIONS"
  | "E_HARD_FACT_KEY_MISMATCH"
  | "E_PLAN_AGGREGATION_BINDING"
  | "E_AGGREGATE_NOT_FOUND"
  | "E_AGGREGATE_NOT_ACCEPTED"
  | "E_AGGREGATE_HASH_MISMATCH"
  | "E_EVD_OBJECT_TOO_LARGE"
  | "E_CONTENT_HASH_MISMATCH"
  | "E_VALIDATOR_BINDING_MISSING"
  | "E_VALIDATOR_POLICY_MISMATCH"
  | "E_SERVICE_STATE_INCONSISTENT";

export type EvdForwardedErrorCode =
  | "E_SOURCE_HASH"
  | "E_SOURCE_NOT_FOUND"
  | "E_SOURCE_UTF8_INVALID"
  | "E_SOURCE_TOO_LARGE"
  | "E_SOURCE_OUT_OF_RANGE"
  | "E_BLOB_MISSING"
  | "E_STORAGE_BUSY"
  | "E_SOURCE_UNRETRIEVABLE"
  | "E_SOURCE_CONFLICT"
  | "E_SOURCE_REF_INVALID"
  | "E_LEDGER_ASOF_UNAVAILABLE"
  | "E_WATERMARK_AHEAD"
  | "E_STATE_ROW_SCHEMA"
  | "E_VERSION_BINDING"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_REBUILD_DIVERGENCE"
  | "E_PLAN_NOT_FOUND"
  | "E_PLAN_HASH_MISMATCH"
  | "E_PLAN_STALE"
  | "E_PLAN_REQUIRED"
  | "E_TEMPLATE_BINDING_MISSING"
  | "E_SOURCE_CHANGED";

export type EvdErrorCode = EvdOwnedErrorCode | EvdForwardedErrorCode;

export type EvdError = ErrorEnvelope & { code: EvdErrorCode };

